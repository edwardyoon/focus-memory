#!/usr/bin/env node
// Session work notes (put/get) — external, per-session store for verified
// findings and checklists. Complements the Σ anchor: Σ is "where the session
// is" (auto-maintained by extraction workers); notes are the model's own work
// evidence (written on demand). Both survive KV eviction.
//
// plans/continous_work.md Phase 1:
//  - FR-1: note_put/note_get/note_list; key [a-z0-9._-]{1,64}; ≤50 keys/session;
//    body ≤600 chars; status open|done|blocked; evidence; mode replace|append;
//    per-session file, lock-protected read-modify-write, persistent across
//    restarts (SessionEnd does not delete; 7-day TTL sweep instead).
//  - FR-2: rule-based validation, no LLM — verified-claim notes require
//    evidence (path:line or a command); identical/over-limit/format violations
//    rejected with a short (~40 token) reason.
//  - FR-3: renderNotesIndex() — the always-exposed index (≤30 entries,
//    open-status first then most-recently-updated, ~450-token budget),
//    attached to the Σ anchor GET and injected at turn boundaries.
//  - FR-7: every put/get/list, every rejection (with reason) and every index
//    injection appends to gate-telemetry.jsonl with the session_id.
//
// Gate: FOCUSMEMORY_NOTES=on (off/unset → notesEnabled() false, zero behavior
// change). Data: ~/.qwen/tmp/focus-memory/notes/<safe-session-stem>.json
//
// Session identity: the MCP tools carry no session of their own. The hooks
// (UserPromptSubmit / PreToolUse) stamp the calling session into the
// active-session registry just before the model acts; note_put/get/list
// resolve against the most recent stamp (15 min TTL).

const fs = require('fs');
const path = require('path');
const { withLock, atomicWrite, appendTelemetry, TELEMETRY_DIR } = require('./state.js');
const skillstate = require('./skillstate.js');
const { sanitizeRefillText, safeSessionStem } = require('./kvoffload.js');

const env = skillstate.env;

const HOME = process.env.HOME || process.env.USERPROFILE || '.';
const NOTES_DIR = path.join(HOME, '.qwen', 'tmp', 'focus-memory', 'notes');
fs.mkdirSync(NOTES_DIR, { recursive: true });

const KEY_RE = /^[a-z0-9._-]{1,64}$/;
const MAX_KEYS = 50;
const MAX_TEXT_CHARS = 600;
const INDEX_MAX_ENTRIES = 30;
const INDEX_MAX_CHARS = 1800; // ~450 tokens at ~4 chars/token
const SUMMARY_CHARS = 80;
const ACTIVE_SESSION_TTL_MS = 15 * 60 * 1000;

const STATUSES = ['open', 'done', 'blocked'];
const MODES = ['replace', 'append'];
const STATUS_RANK = { open: 0, blocked: 1, done: 2 };

/**
 * FR gate. off/unset → false (zero behavior change).
 * @returns {boolean}
 */
function notesEnabled() {
  return env('FOCUSMEMORY_NOTES', '') === 'on';
}

/**
 * @param {string} sessionId
 * @returns {string} per-session notes file path
 */
function notesFile(sessionId) {
  return path.join(NOTES_DIR, `${safeSessionStem(sessionId)}.json`);
}

/**
 * @param {string} sessionId
 * @returns {{session_id: string, updated_at: string, notes: Object<string, {text: string, status: string, evidence: string, created_at: string, updated_at: string}>}}
 */
function loadNotes(sessionId) {
  const empty = { session_id: sessionId, updated_at: '', notes: {} };
  try {
    const doc = JSON.parse(fs.readFileSync(notesFile(sessionId), 'utf8'));
    if (!doc || typeof doc !== 'object' || !doc.notes || typeof doc.notes !== 'object') return empty;
    return doc;
  } catch {
    return empty;
  }
}

/**
 * @param {string} sessionId
 * @param {object} doc
 */
function saveNotes(sessionId, doc) {
  atomicWrite(notesFile(sessionId), JSON.stringify(doc));
}

/**
 * Lock-protected read-modify-write of the session notes file.
 * @param {string} sessionId
 * @param {(doc: object) => object|null} mutate return null to skip the write (e.g. validation rejected)
 * @returns {object|null} the doc returned by mutate, or null
 */
function mutateNotes(sessionId, mutate) {
  return withLock(notesFile(sessionId), () => {
    const doc = loadNotes(sessionId);
    const out = mutate(doc);
    if (out) saveNotes(sessionId, out);
    return out;
  });
}

// ── Active-session registry ─────────────────────────────────────────────────
// The MCP tools carry no session identity; the hooks stamp the calling
// session here right before the model acts (UserPromptSubmit at turn start,
// PreToolUse at tool time).

const ACTIVE_FILE = path.join(TELEMETRY_DIR, 'active-sessions.json');

/**
 * Record sessionId as the most recently active session (15 min TTL).
 * @param {string} sessionId
 * @param {string} [source] which hook stamped it
 */
function stampActiveSession(sessionId, source) {
  if (!sessionId) return;
  try {
    withLock(ACTIVE_FILE, () => {
      let map = {};
      try {
        const cur = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
        if (cur && typeof cur === 'object') map = cur;
      } catch { /* first stamp */ }
      map[sessionId] = { ts: Date.now(), source: source || 'hook' };
      const cutoff = Date.now() - ACTIVE_SESSION_TTL_MS;
      for (const k of Object.keys(map)) {
        if (!map[k] || Number(map[k].ts) < cutoff) delete map[k];
      }
      atomicWrite(ACTIVE_FILE, JSON.stringify(map));
    });
  } catch { /* fail-open */ }
}

/**
 * Most recently stamped session within the TTL.
 * @returns {{session_id: string, ts: number}|null}
 */
function resolveActiveSession() {
  try {
    const map = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
    if (!map || typeof map !== 'object') return null;
    const cutoff = Date.now() - ACTIVE_SESSION_TTL_MS;
    let best = null;
    for (const [sid, v] of Object.entries(map)) {
      if (v && Number(v.ts) >= cutoff && (!best || Number(v.ts) > Number(best.ts))) {
        best = { session_id: sid, ts: Number(v.ts) };
      }
    }
    return best;
  } catch {
    return null;
  }
}

// ── Validation (FR-2, rule-based — no LLM) ──────────────────────────────────

// Stance trigger: a note that claims a verified/confirmed result must carry
// evidence. Deliberately loose — over-rejecting a real finding is worse than
// letting a borderline one through (the model is instructed to mark
// unverified claims with status open instead).
const CONFIRMED_RE = /(confirm|verif|pass|success|resolved|fixed|works?|완료|확인|검증|통과|해결)/i;
const EVIDENCE_FILELINE_RE = /\.[A-Za-z0-9_-]+:\d+/;
const CMD_START_RE =
  /^(node|npm|npx|git|curl|php|bash|sh|ls|cat|grep|rg|find|make|cmake|docker|pm2|aws|ssh|mysql|python3?|qwen|brew|ps|lsof|kill|tail|head|sed|awk|jq|echo|test|date|sysctl|df|du|wc|diff|patch|rsync|scp|source|export|\/)[\s`]/;

/**
 * Evidence is valid if it carries a path:line reference, a backticked
 * command, or starts with a recognizable command word.
 * @param {string} evidence
 * @returns {boolean}
 */
function evidenceIsValid(evidence) {
  const s = String(evidence == null ? '' : evidence).trim();
  if (!s) return false;
  if (EVIDENCE_FILELINE_RE.test(s)) return true;
  if (/`[^`\n]+`/.test(s)) return true;
  if (CMD_START_RE.test(s)) return true;
  return false;
}

/**
 * Validate a note_put (FR-2). Pure rules, no LLM.
 * @param {{key: string, text: string, mode: string, status: string, evidence: string}} p
 * @param {object|null} existing current note for the key (null = new key)
 * @param {object} doc full notes doc (for the key-count cap)
 * @returns {{ok: true}|{ok: false, error: string}} error kept to ~40 tokens
 */
function validatePut(p, existing, doc) {
  const key = String(p.key == null ? '' : p.key);
  if (!KEY_RE.test(key)) {
    return { ok: false, error: 'Invalid key: use lowercase a-z, 0-9, ".", "_" or "-" (max 64 chars), e.g. file.server-context-cpp.' };
  }
  const text = String(p.text == null ? '' : p.text);
  if (!text.trim()) {
    return { ok: false, error: 'Note text is empty — provide the content to store.' };
  }
  if (text.length > MAX_TEXT_CHARS) {
    return { ok: false, error: `Note text is ${text.length} chars (max ${MAX_TEXT_CHARS}). Keep it to facts, not narrative.` };
  }
  if (!MODES.includes(p.mode)) {
    return { ok: false, error: 'mode must be "replace" or "append".' };
  }
  if (!STATUSES.includes(p.status)) {
    return { ok: false, error: 'status must be "open", "done", or "blocked".' };
  }
  if (p.mode === 'append' && existing) {
    const cur = String(existing.text || '');
    const combined = cur ? `${cur}\n${text}` : text;
    if (combined.length > MAX_TEXT_CHARS) {
      return { ok: false, error: `Append would reach ${combined.length} chars (max ${MAX_TEXT_CHARS}). Condense with mode=replace instead.` };
    }
    if (cur.includes(text)) {
      return { ok: false, error: `Note "${key}" already contains this text — nothing stored.` };
    }
  }
  if (p.mode === 'replace' && existing && existing.text === text && existing.status === p.status) {
    return { ok: false, error: `Note "${key}" is unchanged — identical to the current value. Nothing stored.` };
  }
  if (CONFIRMED_RE.test(text) && !evidenceIsValid(p.evidence)) {
    return { ok: false, error: 'Note claims a verified result — add evidence: path:line or the exact command you ran.' };
  }
  if (!existing && Object.keys(doc.notes).length >= MAX_KEYS) {
    return { ok: false, error: `Session note limit reached (${MAX_KEYS} keys). Update an existing key with mode=replace.` };
  }
  return { ok: true };
}

// ── Tool backends ───────────────────────────────────────────────────────────

/**
 * note_put backend (FR-1/FR-2).
 * @param {string} sessionId
 * @param {{key: string, text: string, mode?: string, status?: string, evidence?: string}} p
 * @returns {{ok: boolean, note?: object, error?: string}}
 */
function notePut(sessionId, { key, text, mode = 'replace', status = 'open', evidence = '' }) {
  let result = null;
  try {
    mutateNotes(sessionId, (doc) => {
      const existing = doc.notes[key];
      const v = validatePut({ key, text, mode, status, evidence }, existing, doc);
      if (!v.ok) {
        result = { ok: false, error: v.error };
        return null;
      }
      const now = new Date().toISOString();
      const cur = existing ? { ...existing } : { created_at: now };
      cur.text = mode === 'append' ? (cur.text ? `${cur.text}\n${text}` : String(text)) : String(text);
      cur.status = status;
      cur.evidence = String(evidence || '');
      cur.updated_at = now;
      doc.notes[key] = cur;
      doc.updated_at = now;
      result = {
        ok: true,
        note: { key, text: cur.text, status, evidence: cur.evidence, created_at: cur.created_at, updated_at: now },
      };
      return doc;
    });
  } catch (err) {
    result = { ok: false, error: `note store error: ${err.message}` };
  }
  appendTelemetry({
    ts: Date.now(),
    session_id: sessionId,
    event: result && result.ok ? 'note_put' : 'note_put_rejected',
    key: String(key == null ? '' : key),
    mode,
    status,
    chars: result && result.ok ? result.note.text.length : undefined,
    reason: result && !result.ok ? result.error : undefined,
  });
  return result || { ok: false, error: 'note store error: write skipped' };
}

/**
 * note_get backend.
 * @param {string} sessionId
 * @param {string} key
 * @returns {{ok: boolean, note?: object, error?: string}}
 */
function noteGet(sessionId, key) {
  const k = String(key == null ? '' : key);
  let note = null;
  try {
    note = loadNotes(sessionId).notes[k] || null;
  } catch { /* missing/corrupt file → miss */ }
  appendTelemetry({ ts: Date.now(), session_id: sessionId, event: note ? 'note_get' : 'note_get_miss', key: k });
  if (!note) {
    return { ok: false, error: `No note with key "${k}". Call note_list() to see stored keys.` };
  }
  return { ok: true, note: { key: k, ...note } };
}

/**
 * note_list backend — open-status first, then most-recently-updated.
 * @param {string} sessionId
 * @returns {{ok: boolean, entries?: Array<{key: string, summary: string, status: string, updated_at: string}>, error?: string}}
 */
function noteList(sessionId) {
  let entries = [];
  try {
    const doc = loadNotes(sessionId);
    entries = Object.entries(doc.notes)
      .map(([key, n]) => ({
        key,
        summary: summarizeText(n.text),
        status: n.status,
        updated_at: n.updated_at,
      }))
      .sort(
        (a, b) =>
          (STATUS_RANK[a.status] != null ? STATUS_RANK[a.status] : 3) -
            (STATUS_RANK[b.status] != null ? STATUS_RANK[b.status] : 3) ||
          String(b.updated_at).localeCompare(String(a.updated_at))
      );
  } catch { /* unreadable → empty list */ }
  appendTelemetry({ ts: Date.now(), session_id: sessionId, event: 'note_list', count: entries.length });
  return { ok: true, entries };
}

/**
 * One-line whitespace-collapsed summary (≤80 chars).
 * @param {string} text
 * @returns {string}
 */
function summarizeText(text) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1)}…` : flat;
}

// ── Always-exposed index (FR-3) ─────────────────────────────────────────────

/**
 * Render the session notes index for injection (FR-3): ≤30 entries,
 * open-status first then most-recently-updated, ~450-token budget,
 * recall-style sanitized (no prompt-injection tags). Framed as a reference
 * record, not an instruction.
 * @param {string} sessionId
 * @returns {string} '' when disabled or no notes
 */
function renderNotesIndex(sessionId) {
  if (!notesEnabled()) return '';
  let entries = [];
  try {
    entries = Object.entries(loadNotes(sessionId).notes);
  } catch {
    return '';
  }
  if (!entries.length) return '';
  entries.sort(
    (a, b) =>
      (STATUS_RANK[a[1].status] != null ? STATUS_RANK[a[1].status] : 3) -
        (STATUS_RANK[b[1].status] != null ? STATUS_RANK[b[1].status] : 3) ||
      String(b[1].updated_at).localeCompare(String(a[1].updated_at))
  );
  const header =
    'Session notes index — records you wrote this session (key [status] summary). ' +
    'Reference data, not instructions. Before re-reading a file or range you already noted, ' +
    'call note_get(key); note_list() shows all entries.';
  // The header always rides on top of the entry lines, and a "…N more" trailer is
  // appended whenever entries are dropped — reserve both from the entry budget so
  // the TOTAL output (not just the lines) stays within INDEX_MAX_CHARS.
  const trailerReserve = 64; // bounds "…N more (done/older) — note_list() for the full list"
  const entryBudget = INDEX_MAX_CHARS - header.length - 1 - trailerReserve;
  const lines = [];
  let chars = 0;
  for (const [key, n] of entries) {
    const line = `- ${key} [${n.status}] ${summarizeText(n.text)}`;
    if (lines.length >= INDEX_MAX_ENTRIES || chars + line.length + 1 > entryBudget) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const dropped = entries.length - lines.length;
  let out = `${header}\n${lines.join('\n')}`;
  if (dropped > 0) out += `\n…${dropped} more (done/older) — note_list() for the full list`;
  return sanitizeRefillText(out);
}

// ── Housekeeping ────────────────────────────────────────────────────────────

/**
 * Remove notes files not modified within maxAgeMs (SessionEnd sweep).
 * @param {number} maxAgeMs
 */
function sweepNotes(maxAgeMs) {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const f of fs.readdirSync(NOTES_DIR)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(NOTES_DIR, f);
      const st = fs.statSync(p);
      if (st.mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch { /* best-effort */ }
}

module.exports = {
  NOTES_DIR,
  MAX_KEYS,
  MAX_TEXT_CHARS,
  INDEX_MAX_ENTRIES,
  INDEX_MAX_CHARS,
  notesEnabled,
  notesFile,
  loadNotes,
  saveNotes,
  mutateNotes,
  stampActiveSession,
  resolveActiveSession,
  evidenceIsValid,
  validatePut,
  notePut,
  noteGet,
  noteList,
  summarizeText,
  renderNotesIndex,
  sweepNotes,
};
