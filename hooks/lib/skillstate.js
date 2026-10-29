// SKILL.state shared helpers for FocusMemory hooks (CJS — hooks/ scope).
//
// Implements the Σ (structured execution state) design from the SKILL.state
// paper (arXiv:2608.26263): instead of letting native compaction reduce a
// long session to a prose summary, we extract a structured state patch from
// the pre-compaction transcript, merge it into a per-session Σ file, and
// re-inject Σ after compaction so the model conditions on explicit state
// rather than reconstructed history.
//
// Everything here is fail-open by design: a hook must never block or break
// the native compaction flow. Any error → the hook exits silently and qwen
// proceeds with its normal behavior.
//
// Feature gate: FOCUSMEMORY_SKILLSTATE=on (any other value / unset → the
// entry hooks return immediately; auto-recall + Hard Gate are untouched).

const fs = require('fs');
const path = require('path');
const { withLock, atomicWrite, appendTelemetry, STATE_DIR } = require('./state.js');
// stripInjectedBlocks (kvoffload.js): removes client-appended context blocks
// (user-prompt-submit context, system-reminder) before digesting transcript
// text, so injected blocks cannot roll back into the recent-work digest.
const { stripInjectedBlocks } = require('./kvoffload.js');

const HOME = process.env.HOME || process.env.USERPROFILE || '.';
const SIGMA_DIR = path.join(HOME, '.qwen', 'tmp', 'focus-memory', 'state');
fs.mkdirSync(SIGMA_DIR, { recursive: true });

// .env next to the hooks/ parent (FocusMemory/.env) — same file the MCP
// server loads, so hooks hit the same local services without needing the
// mcpServers env block (that only applies to the MCP process, not command hooks).
const DOTENV_PATH = path.join(__dirname, '..', '..', '.env');
let _dotenvCache = null;

/**
 * Parse FocusMemory/.env into a key/value map (no process.env override).
 * Cached per process; hooks are short-lived so staleness is a non-issue.
 * @returns {Object<string,string>}
 */
function loadDotEnv() {
  if (_dotenvCache) return _dotenvCache;
  _dotenvCache = {};
  try {
    for (const line of fs.readFileSync(DOTENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) _dotenvCache[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return _dotenvCache;
}

/**
 * Resolve a config value: process.env first, then FocusMemory/.env, then fallback.
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function env(key, fallback) {
  if (process.env[key]) return process.env[key];
  const v = loadDotEnv()[key];
  return v || fallback;
}

/**
 * Feature gate — true only when FOCUSMEMORY_SKILLSTATE is exactly "on".
 * Resolved via env(): process env first, then FocusMemory/.env — so the
 * gate can be set either in the shell (or qwen settings env) or in .env.
 * Any other value / unset → off (hooks return immediately at the entry).
 * @returns {boolean}
 */
function skillStateEnabled() {
  return env('FOCUSMEMORY_SKILLSTATE', '') === 'on';
}

/**
 * Absolute path of a session's Σ file.
 * @param {string} sessionId
 * @returns {string}
 */
function sigmaFile(sessionId) {
  return path.join(SIGMA_DIR, `${sessionId}.json`);
}

/**
 * Read a session's Σ; missing or corrupt file yields {}.
 * @param {string} sessionId
 * @returns {object}
 */
function loadSigma(sessionId) {
  try {
    if (fs.existsSync(sigmaFile(sessionId))) {
      return JSON.parse(fs.readFileSync(sigmaFile(sessionId), 'utf8'));
    }
  } catch {}
  return {};
}

/**
 * Lock-protected write of a session's Σ file (shares the lock discipline of
 * lib/state.js — a different file, so no lock contention with tool-calls state).
 * @param {string} sessionId
 * @param {object} sigma
 */
function saveSigma(sessionId, sigma) {
  const file = sigmaFile(sessionId);
  withLock(file, () => {
    atomicWrite(file, JSON.stringify(sigma, null, 2));
  });
}

/**
 * Lock-protected read-modify-write of a session's Σ file. loadSigma() +
 * saveSigma() are separate steps: the Stop hooks run as concurrent
 * processes on the same event, so two of them can interleave
 * read→modify→write and drop each other's update (lost update — observed
 * 2026-09-28: a same-second stop-checkpoint save clobbered the ghost-gate
 * block counter, disabling its loop guard and allowing three consecutive
 * fires on one missing file). The mutator runs against a fresh read inside
 * the lock, making the whole cycle atomic.
 * @param {string} sessionId
 * @param {(sigma: object) => object|null} mutate - receives the current Σ, returns the next Σ (or null to skip the write)
 * @returns {object|null} the Σ as written (null when mutate skipped)
 */
function mutateSigma(sessionId, mutate) {
  const file = sigmaFile(sessionId);
  return withLock(file, () => {
    const current = loadSigma(sessionId);
    const next = mutate(current);
    if (next === null) return null;
    atomicWrite(file, JSON.stringify(next, null, 2));
    return next;
  });
}

// ─── Model-owned session notes (verbatim work evidence) ─────────────────────
// `notes` is a model-owned Σ key: the model writes it via the sigma_note MCP
// tool, and the extraction LLM never touches it (mergeSigma drops any `notes`
// in a patch — see KEY_RULES.model_only). It lives in the same Σ file as the
// anchor, so it survives KV eviction like the anchor does, and is re-injected
// verbatim by renderAnchor every turn (no re-derivation). Per-task: wiped on
// the post-completion reset (anchor_reset_pending) like the other current-view
// keys.
const NOTE_KEY_RE = /^[a-z0-9._-]{1,64}$/;
const NOTE_MAX_KEYS = 8;
const NOTE_MAX_CHARS = 500;

/**
 * Upsert one model-owned note in the session's Σ (locked read-modify-write).
 * @param {string} sessionId
 * @param {string} key - lowercase a-z, 0-9, ".", "_", "-" (max 64)
 * @param {string} text - verbatim note text (max 500 chars)
 * @param {string} [mode='set'] - 'set' replaces, 'append' adds a line
 * @returns {{ok: boolean, note?: {key: string, text: string}, error?: string}}
 */
function setSigmaNote(sessionId, key, text, mode = 'set') {
  const k = String(key == null ? '' : key);
  const t = String(text == null ? '' : text);
  if (!NOTE_KEY_RE.test(k)) {
    return { ok: false, error: 'Invalid key: use lowercase a-z, 0-9, ".", "_" or "-" (max 64 chars).' };
  }
  if (!t.trim()) return { ok: false, error: 'Note text is empty.' };
  if (mode !== 'set' && mode !== 'append') return { ok: false, error: 'mode must be "set" or "append".' };
  if (t.length > NOTE_MAX_CHARS) {
    return { ok: false, error: `Note text is ${t.length} chars (max ${NOTE_MAX_CHARS}). Keep it to facts.` };
  }
  let result = null;
  try {
    mutateSigma(sessionId, (sigma) => {
      const base = sigma && typeof sigma === 'object' ? sigma : {};
      const cur = typeof base.notes === 'object' && base.notes !== null && !Array.isArray(base.notes) ? base.notes : {};
      const notes = { ...cur };
      const existing = typeof notes[k] === 'string' ? notes[k] : null;
      if (mode === 'append' && existing) {
        const combined = `${existing}\n${t}`;
        if (combined.length > NOTE_MAX_CHARS) {
          result = { ok: false, error: `Append would reach ${combined.length} chars (max ${NOTE_MAX_CHARS}). Use mode="set" to condense.` };
          return null;
        }
        notes[k] = combined;
      } else if (!existing && Object.keys(notes).length >= NOTE_MAX_KEYS) {
        result = { ok: false, error: `Note limit reached (${NOTE_MAX_KEYS} keys). Update an existing key with mode="set".` };
        return null;
      } else {
        notes[k] = t;
      }
      base.notes = notes;
      result = { ok: true, note: { key: k, text: notes[k] } };
      return base;
    });
  } catch (err) {
    result = { ok: false, error: `note store error: ${err.message}` };
  }
  return result || { ok: false, error: 'note write skipped' };
}

// ─── Active-session registry (MCP tool → caller identity) ────────────────────
// The sigma_note MCP tool carries no session of its own. Resolution layers
// (resolveActiveSession, 2026-10-21):
//   1. QWEN_CODE_SESSION_ID — qwen-code sets this in the per-session MCP
//      server's env (the MCP server is spawned per session), so inside the
//      server it IS the caller: deterministic, no TTL, no cross-session race.
//      Primary on every qwen-code host, including ACP/VS Code — the host that
//      never fires PreToolUse and therefore leaves no layer-2 stamp at all.
//   2. PreToolUse stamp (log-tool-call.js) under a 15-min TTL — the mechanism
//      the spec'd-out notes.js used (commit 6e5db5e); fallback for hosts that
//      don't set the env.
//   3. Freshest per-session Σ state file mtime under the same TTL — last
//      resort (UserPromptSubmit/Stop hooks write it every live turn). The TTL
//      gate keeps a session switch from adopting the previous session's Σ.
const ACTIVE_SESSION_FILE = path.join(SIGMA_DIR, 'active-sessions.json');
const ACTIVE_SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stamp a session as the freshest active caller (used by the PreToolUse hook).
 * @param {string} sessionId
 * @param {string} [source]
 * @returns {void}
 */
function stampActiveSession(sessionId, source) {
  if (!sessionId) return;
  try {
    withLock(ACTIVE_SESSION_FILE, () => {
      let map = {};
      try {
        const cur = JSON.parse(fs.readFileSync(ACTIVE_SESSION_FILE, 'utf8'));
        if (cur && typeof cur === 'object') map = cur;
      } catch { /* first stamp */ }
      map[sessionId] = { ts: Date.now(), source: source || 'hook' };
      const cutoff = Date.now() - ACTIVE_SESSION_TTL_MS;
      for (const k of Object.keys(map)) {
        if (!map[k] || Number(map[k].ts) < cutoff) delete map[k];
      }
      atomicWrite(ACTIVE_SESSION_FILE, JSON.stringify(map));
    });
  } catch { /* fail-open */ }
}

/**
 * Resolve the calling session (for the sigma_note MCP tool).
 * Primary: QWEN_CODE_SESSION_ID (qwen-code per-session MCP env — exact
 * identity, no TTL). Fallbacks: newest PreToolUse stamp under the 15-min TTL,
 * then the newest per-session Σ state file mtime under the same TTL.
 * @returns {{session_id: string, ts: number, source: string}|null}
 */
function resolveActiveSession() {
  const envSid = (process.env.QWEN_CODE_SESSION_ID || '').trim();
  if (SESSION_UUID_RE.test(envSid)) {
    return { session_id: envSid, ts: Date.now(), source: 'env' };
  }
  const cutoff = Date.now() - ACTIVE_SESSION_TTL_MS;
  try {
    const map = JSON.parse(fs.readFileSync(ACTIVE_SESSION_FILE, 'utf8'));
    if (map && typeof map === 'object') {
      let best = null;
      for (const [sid, v] of Object.entries(map)) {
        if (v && Number(v.ts) >= cutoff && (!best || Number(v.ts) > Number(best.ts))) {
          best = { session_id: sid, ts: Number(v.ts), source: 'stamp' };
        }
      }
      if (best) return best;
    }
  } catch { /* no stamp file */ }
  return freshestSigmaSession();
}

/**
 * The freshest per-session Σ state file under the 15-min TTL (the layer-3
 * liveness signal, standalone). The Stop/UserPromptSubmit hooks rewrite the
 * running session's Σ every turn with the real session id from the hook
 * payload, so the freshest mtime identifies the live session.
 * @returns {{session_id: string, ts: number, source: string}|null}
 */
function freshestSigmaSession() {
  const cutoff = Date.now() - ACTIVE_SESSION_TTL_MS;
  try {
    let best = null;
    for (const f of fs.readdirSync(SIGMA_DIR)) {
      if (f === 'active-sessions.json' || !f.endsWith('.json')) continue;
      const sid = f.slice(0, -5);
      if (!SESSION_UUID_RE.test(sid)) continue;
      let st;
      try { st = fs.statSync(path.join(SIGMA_DIR, f)); } catch { continue; }
      if (st.mtimeMs >= cutoff && (!best || st.mtimeMs > best.ts)) {
        best = { session_id: sid, ts: st.mtimeMs, source: 'state_file' };
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Bump Σ.compact_count (locked read-modify-write) with a 30s dedup window so a
 * single compaction firing both PostCompact and SessionStart counts once, while
 * distinct compactions (minutes apart) each count. Stores last bump ts for the
 * dedup. Returns the new count, or null when the write was skipped (dedup / no Σ).
 * @param {string} sessionId
 * @returns {number|null}
 */
function bumpCompactCount(sessionId) {
  const DEDUP_MS = 30000;
  let newCount = null;
  try {
    mutateSigma(sessionId, (sigma) => {
      if (!sigma || Object.keys(sigma).length === 0) return null; // no Σ — fail-open
      const now = Date.now();
      const last = Number(sigma.last_compact_bump_ts) || 0;
      if (now - last < DEDUP_MS) return null; // dedup — same compaction already counted
      sigma.compact_count = (Number.isFinite(sigma.compact_count) ? sigma.compact_count : 0) + 1;
      sigma.last_compact_bump_ts = now;
      newCount = sigma.compact_count;
      return sigma;
    });
  } catch {
    // fail-open — the window simply stays closed this round
  }
  return newCount;
}

/**
 * Delete SIGMA_DIR files older than maxAgeMs (mtime), optionally restricted
 * to names starting with `prefix`. Best-effort; returns removed count.
 * @param {number} maxAgeMs - 0 means "delete regardless of age" (within prefix)
 * @param {string} [prefix]
 * @returns {number}
 */
function sweepSigma(maxAgeMs, prefix = null) {
  const cutoff = Date.now() - maxAgeMs;
  let entries;
  try {
    entries = fs.readdirSync(SIGMA_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (prefix && !name.startsWith(prefix)) continue;
    if (!/\.(json|tmp|lock)$/.test(name)) continue;
    const full = path.join(SIGMA_DIR, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {}
  }
  return removed;
}

// ─── Anchor rendering + transcript digest ──────────────────────────────

/**
 * Rule-based digest of the recent transcript entries (recent_work MCP tool +
 * mid-turn Σ auto-injection, 2026-10-23). NO LLM: inside long autonomous
 * turns the model forgets its own recent actions (within-turn tool results
 * are evicted first, Σ lags by a turn), so the RAW transcript tail is the
 * freshest action record — compressed to tool name + target + status.
 *
 * Reads only the last 64KB of the transcript JSONL. The file is appended in
 * real time during a turn (verified 2026-10-23: entries land with age ~0s
 * mid-turn), so a mid-turn read sees the current turn's calls and results.
 * The first tail line is discarded when the 64KB cut lands mid-line (it may
 * be truncated JSON) and unparseable lines are skipped. `system` entries
 * (per-event bookkeeping, no message parts) are ignored; user/assistant
 * carry text parts, tool_result carries functionResponse parts.
 *
 * Line grammar (chronological, oldest→newest):
 *   HH:MM <tool> <target>|<command first 80 chars>   (assistant tool call)
 *   ok | error: <first 60 chars>                     (tool result — BODY NEVER:
 *   [ai] <first 100 chars>                           including bodies is what
 *   [user] <first 150 chars>                         would persist instructions
 *   read <path> ×N                                   embedded in web/file
 * Consecutive reads of the same file collapse to `read X ×N` (intermediate
 * result lines dropped); over maxChars the OLDEST lines drop first.
 * @param {string} transcriptPath - session transcript JSONL (event.transcript_path)
 * @param {object} [opts]
 * @param {number} [opts.events=24] - max transcript entries (tail window)
 * @param {number} [opts.maxChars=1600] - digest char cap
 * @returns {string} digest text; '' on any failure (fail-open)
 */
function digestTranscript(transcriptPath, opts = {}) {
  const events = Math.max(1, Number(opts.events) || 24);
  const maxChars = Math.max(200, Number(opts.maxChars) || 1600);
  if (!transcriptPath) return '';
  let tail;
  try {
    const size = fs.statSync(transcriptPath).size;
    const cut = size > 64 * 1024;
    const len = Math.min(size, 64 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      tail = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // First tail line may be cut mid-JSON at the byte boundary — discard it.
    if (cut) {
      const nl = tail.indexOf('\n');
      if (nl >= 0) tail = tail.slice(nl + 1);
    }
  } catch {
    return '';
  }
  const entries = [];
  for (const line of tail.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* skip unparseable (a torn append) */
    }
  }
  const hhmm = (ts) => (typeof ts === 'string' && ts.length >= 16 ? ts.slice(11, 16) : '');
  const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

  // {text, baseText, kind: 'read'|'result'|'call'|'text', readPath, count}
  const out = [];
  for (const e of entries.slice(-events)) {
    const parts = e.message && Array.isArray(e.message.parts) ? e.message.parts : [];
    const t = hhmm(e.timestamp);
    if (e.type === 'assistant') {
      for (const p of parts) {
        const fc = p.functionCall;
        if (!fc || typeof fc.name !== 'string') continue;
        const args = fc.args && typeof fc.args === 'object' ? fc.args : {};
        const target =
          typeof args.file_path === 'string' ? args.file_path
          : typeof args.path === 'string' ? args.path
          : '';
        const cmd =
          typeof args.command === 'string' ? args.command
          : typeof args.query === 'string' ? args.query
          : typeof args.pattern === 'string' ? args.pattern
          : '';
        if (fc.name === 'read_file' && target) {
          // Collapse consecutive same-file reads (result line may sit in
          // between) into `read X ×N`; intermediate results are dropped —
          // only the final status survives.
          let li = out.length - 1;
          if (
            li >= 1 && out[li].kind === 'result' &&
            out[li - 1].kind === 'read' && out[li - 1].readPath === target
          ) {
            out.pop();
            li -= 1;
          }
          if (li >= 0 && out[li].kind === 'read' && out[li].readPath === target) {
            const rd = out[li];
            rd.count = (rd.count || 1) + 1;
            rd.text = `${rd.baseText} ×${rd.count}`;
          } else {
            out.push({
              text: `${t} read ${target}`,
              baseText: `${t} read ${target}`,
              kind: 'read',
              readPath: target,
              count: 1,
            });
          }
        } else {
          const cmdPart = cmd ? `|${flat(cmd).slice(0, 80)}` : '';
          out.push({
            text: `${t} ${fc.name}${target ? ` ${target}` : ''}${cmdPart}`,
            kind: 'call',
          });
        }
      }
      const text = flat(parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join(' '));
      if (text) out.push({ text: `[ai] ${flat(stripInjectedBlocks(text)).slice(0, 100)}`, kind: 'text' });
    } else if (e.type === 'tool_result') {
      for (const p of parts) {
        const fr = p.functionResponse;
        if (!fr || !fr.response) continue;
        const err = fr.response.error;
        // Result BODY is never included — status only. This is what blocks
        // instructions embedded in web/file content from being persisted via
        // the digest into the Σ auto-injection.
        out.push({ text: err ? `error: ${flat(err).slice(0, 60)}` : 'ok', kind: 'result' });
      }
    } else if (e.type === 'user') {
      const text = flat(parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join(' '));
      if (text) out.push({ text: `[user] ${flat(stripInjectedBlocks(text)).slice(0, 150)}`, kind: 'text' });
    }
    // 'system' entries: bookkeeping only (no message parts) — ignored.
  }
  let lines = out.map((o) => o.text);
  while (lines.length > 1 && lines.join('\n').length > maxChars) {
    lines.shift(); // over budget → drop the OLDEST lines first
  }
  return lines.join('\n').slice(0, maxChars);
}

/**
 * Render a compact "where are we" anchor from Σ. One line, capped — the
 * anchor must cost a negligible fraction of the context it is meant to
 * protect.
 * @param {object} sigma
 * @param {object} [opts]
 * @param {boolean} [opts.record=false] - true: label task/step as a RECORD of
 *   the previous turn, not the current task. Required by the per-turn
 *   UserPromptSubmit anchor: that state is one turn behind by construction,
 *   and the imperative "task:" label made the model resume a
 *   completed/superseded task instead of answering the user's new message
 *   (2026-10-02 incident: mid-investigation jump back to a finished
 *   re-apply task). false (default): directive framing, for callers that
 *   resume the work (stop-turn-guard).
 * @returns {string} compact anchor text (empty string when Σ has no content)
 */
function renderAnchor(sigma, opts = {}) {
  if (!sigma || typeof sigma !== 'object') return '';
  const record = !!opts.record;
  const parts = [];
  if (sigma.anchor_revoked === true) parts.push('original-task-anchor: REVOKED by user');
  if (sigma.anchor_completed === true) parts.push('original-task-anchor: COMPLETED');

  // Model-owned verbatim notes (2026-10-20): re-injected exactly as the model
  // wrote them (no re-derivation). They take precedence over the extracted
  // sections below when they conflict — the model wrote them mid-task, so they
  // are fresher than the one-turn-behind extraction.
  if (sigma.notes && typeof sigma.notes === 'object' && !Array.isArray(sigma.notes)) {
    const noteEntries = Object.entries(sigma.notes)
      .filter(([, v]) => typeof v === 'string' && v.trim())
      .slice(0, NOTE_MAX_KEYS);
    if (noteEntries.length) {
      parts.push(`notes (you wrote these, verbatim — take precedence over the sections below when they conflict): ${noteEntries.map(([k, v]) => `${k}: ${v}`).join(' | ')}`);
    }
  }

  // 2026-10-09 three-section schema: confirmed (verified, file:line) /
  // hypothesis (unverified) / next (outstanding steps). next first — it is
  // what the next turn acts on; confirmed second — the verified ground the
  // action relies on; hypothesis last — the least trustworthy.
  const strList = (k) => (Array.isArray(sigma[k]) ? sigma[k].filter((x) => typeof x === 'string' && x.trim()) : []);
  const next = strList('next');
  const confirmed = strList('confirmed');
  const hypothesis = strList('hypothesis');
  // blocked first — constraints (DO NOT RETRY) must precede the actions they
  // constrain; migrated from session notes' blocked status (2026-10-15).
  const blocked = strList('blocked');
  if (blocked.length) parts.push(`blocked (DO NOT RETRY): ${blocked.slice(0, 3).join('; ')}`);
  if (next.length) parts.push(`next: ${next.slice(0, 5).join('; ')}`);
  if (confirmed.length) parts.push(`confirmed: ${confirmed.slice(0, 10).join('; ')}`);
  if (hypothesis.length) parts.push(`hypothesis (UNVERIFIED — re-check before acting): ${hypothesis.slice(0, 5).join('; ')}`);

  // Legacy fallback — pre-2026-10-09 Σ files still carry the flat keys;
  // render them until the next extraction overwrites them with sections.
  if (sigma.task_summary) parts.push(record
    ? `previous-turn task (record — NOT the current task): ${sigma.task_summary}`
    : `task: ${sigma.task_summary}`);
  if (sigma.current_step) parts.push(record
    ? `previous-turn step (record — NOT a directive): ${sigma.current_step}`
    : `step: ${sigma.current_step}`);
  if (Array.isArray(sigma.pending_checks) && sigma.pending_checks.length) {
    parts.push(`pending: ${sigma.pending_checks.slice(0, 5).join('; ')}`);
  }
  if (Array.isArray(sigma.files_touched) && sigma.files_touched.length) {
    parts.push(`files: ${sigma.files_touched.slice(-5).join(', ')}`);
  }
  if (sigma.tests_status && typeof sigma.tests_status === 'object' && !Array.isArray(sigma.tests_status)) {
    const failing = Object.entries(sigma.tests_status)
      .filter(([, v]) => v === 'fail')
      .map(([k]) => k);
    if (failing.length) parts.push(`failing: ${failing.join(', ')}`);
  }

  if (Array.isArray(sigma.recall_pointers) && sigma.recall_pointers.length) {
    const n = sigma.recall_pointers.length;
    const last = sigma.recall_pointers[n - 1];
    const hint = last && last.hint ? ` (most recent: ${last.hint})` : '';
    parts.push(
      `offloaded: ${n} segment(s) from before compaction left the context. ` +
      `Their chunk numbers are in the "offloaded" chunk list of the attention scaffold ` +
      `(not a session note, not a tool). To re-read one, emit <focus magic_chunks="N"> ` +
      `on its own line with that number${hint}`
    );
  }
  return parts.join(' | ');
}

// ─── Σ merge (paper: Σ_{t+1} = Σ_t ⊕ Δ, null deletes a key) ─────────────

// Per-key merge semantics. The content schema (2026-10-09) is three
// epistemic sections, all "current view" snapshots (replace): the extractor
// outputs the full current list or omits the key when unchanged.
//   confirmed  — facts verified by a tool call; each item cites file:line
//   hypothesis — beliefs not yet verified by a tool call
//   next       — outstanding steps, in execution order
const KEY_RULES = {
  confirmed: 'replace',
  hypothesis: 'replace',
  next: 'replace',
  // Active blockers (migrated from session notes' blocked status, 2026-10-15):
  // a current-view snapshot of what must NOT be retried until it clears.
  blocked: 'replace',
  // Snapshot of the offloaded (evicted) segments the model can re-load via
  // <focus> after compaction. Sourced mechanically from the kv-offload store
  // (NOT the LLM) by precompact-extract-state.js — a current-view snapshot, so
  // it replaces rather than accumulates.
  recall_pointers: 'replace',
  // Once the user revokes the original task anchor, it never un-revokes:
  // an LLM "false" (or omission) can leave the flag alone, never clear it.
  anchor_revoked: 'sticky_true',
  // B4 extension (2026-10-03): the completion release is one-way too — once
  // the original task is fully done, a later LLM "false"/omission must not
  // re-pin the stale anchor. The pin releases on completion (not only on
  // supersede), so the first turn after the task ends does not run under a
  // stale anchor (incident a39ee3d9).
  anchor_completed: 'sticky_true',
  // Model-owned verbatim work notes (2026-10-20): written ONLY by the model via
  // the sigma_note MCP tool, never by the extraction LLM. mergeSigma drops any
  // `notes` in a patch mechanically (code, not prompt) so the extractor can
  // never overwrite or re-derive them. See setSigmaNote().
  notes: 'model_only',
};
// Per-section item caps — keep Σ within the ~800-token injection budget.
const SECTION_CAPS = { confirmed: 10, hypothesis: 5, next: 5, blocked: 3 };
const MAX_LIST_ITEMS = 50; // cap cumulative lists so Σ stays injection-sized

/**
 * Merge a state patch into the current Σ (null values delete keys).
 * @param {object} current
 * @param {object} patch
 * @returns {object} the merged Σ (new object)
 */
function mergeSigma(current, patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    // Model-owned key (notes): the extraction LLM must never write or clear
    // it. Drop the patch value mechanically — keep the model-written notes.
    if (KEY_RULES[key] === 'model_only') continue;
    if (value === null || value === undefined) {
      delete next[key];
      continue;
    }
    const rule = KEY_RULES[key] || (Array.isArray(value) ? 'union' : typeof value === 'object' ? 'merge' : 'replace');
    if (rule === 'union' && Array.isArray(value)) {
      const base = Array.isArray(next[key]) ? next[key] : [];
      const merged = [...base];
      for (const item of value) {
        if (!merged.includes(item)) merged.push(item);
      }
      next[key] = merged.slice(-MAX_LIST_ITEMS);
    } else if (rule === 'merge' && typeof value === 'object') {
      const base = (typeof next[key] === 'object' && next[key] !== null && !Array.isArray(next[key])) ? next[key] : {};
      const merged = { ...base };
      for (const [k, v] of Object.entries(value)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      next[key] = merged;
    } else if (rule === 'sticky_true') {
      next[key] = next[key] === true || value === true;
    } else {
      // Section snapshots: keep only non-empty strings, enforce the
      // per-section item cap (the ~800-token Σ budget).
      if (Array.isArray(value) && SECTION_CAPS[key] != null) {
        next[key] = value.filter((x) => typeof x === 'string' && x.trim()).slice(0, SECTION_CAPS[key]);
      } else {
        next[key] = value;
      }
    }
  }
  // 2026-10-12: on the transition to completed/revoked, clear the
  // outstanding-work fields (next, hypothesis, blocked) unless the extractor
  // provided fresh ones. A completed task whose stale next/hypothesis
  // lingers gets re-injected as the next turn's anchor and the model
  // resumes/re-verifies finished work (recurring 2026-10-02 incident:
  // the render-side record frame covered only the legacy flat keys, so
  // the 3-section `next` still read as a directive after COMPLETED).
  // Fires only on the transition (not on sticky re-output), so a later
  // new task's steps are never over-suppressed. confirmed is kept — it
  // is historical ground, not outstanding work.
  const doneTransition =
    (patch.anchor_completed === true && current.anchor_completed !== true) ||
    (patch.anchor_revoked === true && current.anchor_revoked !== true);
  if (doneTransition) {
    for (const k of ['next', 'hypothesis', 'blocked']) {
      const provided = Array.isArray(patch[k]) && patch[k].some((x) => typeof x === 'string' && x.trim());
      if (!provided) next[k] = [];
    }
  }
  return next;
}

// Ghost-reference filter (2026-09-26 context-confusion incident): the
// extractor LLM can transcribe a confabulated file citation straight out of
// an assistant message (the incident: a turn that cited todos/2026-07-06.md
// — a file that never existed — produced a Σ pending item that re-injected
// into later sessions). This mechanical pre-merge check drops NEW patch
// items that cite a dated todos file absent from disk. Conservative scope:
// dated todos citations only, string array items only (confirmed /
// hypothesis / next), and patch items only — existing Σ content is never
// rewritten here (the Stop hook's ghost-file gate handles the live turn;
// this blocks propagation into the next session).
const GHOST_TODO_REF_RE = /((?:\/?[A-Za-z0-9._-]+\/)*todos\/\d{4}-\d{2}-\d{2}\.md)/g;

/**
 * Drop new patch items citing dated todos files that do not exist on disk.
 * @param {object} patch - extracted state patch (mutated in place)
 * @param {string} cwd - session working directory (relative-citation base)
 * @returns {{patch: object, removed: Array<{key: string, item: string, refs: string[]}>}} the (mutated) patch plus the removed items for telemetry
 */
function filterGhostRefs(patch, cwd) {
  const removed = [];
  if (!patch || typeof patch !== 'object' || !cwd) return { patch, removed };
  for (const key of ['confirmed', 'hypothesis', 'next', 'blocked']) {
    const arr = patch[key];
    if (!Array.isArray(arr)) continue;
    patch[key] = arr.filter((item) => {
      if (typeof item !== 'string') return true;
      const ghosts = (item.match(GHOST_TODO_REF_RE) || []).filter((ref) => {
        const abs = path.isAbsolute(ref) ? ref : path.join(cwd, ref);
        let exists = false;
        try {
          exists = fs.existsSync(abs);
        } catch {}
        return !exists;
      });
      if (ghosts.length) removed.push({ key, item, refs: ghosts });
      return ghosts.length === 0;
    });
    if (patch[key].length === 0) delete patch[key];
  }
  return { patch, removed };
}

// Foreign-session state reference (2026-10-17 incident): the model reads
// ANOTHER session's Σ file (state/<uuid>.json) — e.g. during incident
// forensics — and the extraction LLM distills that citation (sometimes with
// the foreign session's facts) into THIS session's Σ. Re-injected, the
// foreign anchor re-latches the model onto another session's task. The
// pattern matches the 8-hex uuid prefix followed by either dash groups
// (full or partial uuid) or an elision marker (`…` / `...`). The dot
// before `json` is optional: the ASCII-dots form swallows it
// (`state/29a17fe5-...json`), while `…` leaves it (`-….json`). Plain
// project files like state/abcd1234.json (no dash, no elision) never match.
const FOREIGN_STATE_REF_RE = /state\/([0-9a-f]{8}(?:(?:-[0-9a-f]+)*-?(?:…|\.\.\.)|(?:-[0-9a-f]+)+))\.?json/g;

/**
 * Foreign session prefixes cited by a string — `state/<uuid>.json` refs whose
 * first 8 hex chars do not match the current session's id. Self-references
 * (the session citing its own Σ file) are allowed: the incident pattern is
 * foreign refs only.
 * @param {string} item
 * @param {string} sessionId - the current session's id
 * @returns {string[]} the foreign 8-hex prefixes (empty when clean)
 */
function foreignSessionRefs(item, sessionId) {
  if (typeof item !== 'string' || !sessionId) return [];
  const out = [];
  for (const m of item.matchAll(FOREIGN_STATE_REF_RE)) {
    const prefix = m[1].slice(0, 8);
    if (sessionId.slice(0, 8) !== prefix && !out.includes(prefix)) out.push(prefix);
  }
  return out;
}

/**
 * Drop new patch items citing OTHER sessions' state files. Mechanical
 * pre-merge gate (the extraction-prompt cross-session rule is the soft
 * layer). Patch items only — existing Σ content is scrubbed at presentation
 * time (userprompt-inject-state.js / sessionstart-inject-state.js), which
 * also cleans Σ files written before this filter existed.
 * @param {object} patch - extracted state patch (mutated in place)
 * @param {string} sessionId - the current session's id
 * @returns {{patch: object, removed: Array<{key: string, item: string, refs: string[]}>}} the (mutated) patch plus the removed items for telemetry
 */
function filterForeignSessionRefs(patch, sessionId) {
  const removed = [];
  if (!patch || typeof patch !== 'object' || !sessionId) return { patch, removed };
  for (const key of ['confirmed', 'hypothesis', 'next', 'blocked']) {
    const arr = patch[key];
    if (!Array.isArray(arr)) continue;
    patch[key] = arr.filter((item) => {
      const refs = foreignSessionRefs(item, sessionId);
      if (refs.length) removed.push({ key, item, refs });
      return refs.length === 0;
    });
    if (patch[key].length === 0) delete patch[key];
  }
  return { patch, removed };
}

/**
 * Scrub a loaded Σ's content sections of foreign-session state refs (in
 * place). Presentation-time gate: covers Σ files written before
 * filterForeignSessionRefs existed and any leak the merge gate missed, so a
 * foreign anchor is never re-presented to the model.
 * @param {object} sigma - the loaded Σ (mutated in place)
 * @param {string} sessionId - the current session's id
 * @returns {Array<{key: string, item: string, refs: string[]}>} the removed items for telemetry
 */
function scrubSigmaForeignRefs(sigma, sessionId) {
  const removed = [];
  if (!sigma || typeof sigma !== 'object' || !sessionId) return removed;
  for (const key of ['confirmed', 'hypothesis', 'next', 'blocked']) {
    const arr = sigma[key];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((item) => {
      const refs = foreignSessionRefs(item, sessionId);
      if (refs.length) removed.push({ key, item, refs });
      return refs.length === 0;
    });
    if (kept.length !== arr.length) sigma[key] = kept;
  }
  return removed;
}

// ─── Transcript extraction ────────────────────────────────────────────────

/**
 * Truncate a string to maxChars with an ellipsis marker.
 * @param {string} s
 * @param {number} maxChars
 * @returns {string}
 */
function clip(s, maxChars) {
  s = String(s);
  return s.length > maxChars ? `${s.slice(0, maxChars)}…[truncated]` : s;
}

/**
 * Serialize one transcript entry to compact text (or null to skip it).
 * Skips system snapshots; keeps user text, assistant text + tool calls,
 * and truncated tool results — enough to extract state, not the full history.
 * @param {object} entry - parsed JSONL line
 * @returns {string|null}
 */
function entryToText(entry) {
  if (!entry || !entry.type || !entry.message || !Array.isArray(entry.message.parts)) return null;
  const parts = [];
  for (const part of entry.message.parts) {
    if (entry.type === 'user' && part.text) {
      parts.push(clip(part.text, 4000));
    } else if (entry.type === 'assistant' && part.text) {
      parts.push(clip(part.text, 4000));
    } else if (part.functionCall) {
      let args = '';
      try { args = JSON.stringify(part.functionCall.args || {}); } catch {}
      parts.push(`[call] ${part.functionCall.name} ${clip(args, 500)}`);
    } else if (part.functionResponse) {
      let resp = '';
      try { resp = JSON.stringify(part.functionResponse.response || {}); } catch {}
      parts.push(`[result ${part.functionResponse.name}] ${clip(resp, 800)}`);
    }
  }
  if (parts.length === 0) return null;
  const prefix = entry.type === 'user' ? '[user]' : entry.type === 'assistant' ? '[assistant]' : '[tool]';
  return `${prefix} ${parts.join(' | ')}`;
}

/**
 * Read the tail of a transcript JSONL within a character budget and render
 * it as compact text. Tail-based: the most recent work is what the next
 * post-compaction turn needs; earlier state is already accumulated in Σ.
 * The budget is measured on RENDERED (post-clip) length, so one giant
 * tool_result line costs its clipped size (~800 chars), not its raw size.
 *
 * User-message guarantee (2026-10-03, incident a39ee3d9): the walk extends
 * past budgetChars (up to opts.maxChars) until at least opts.minUserEntries
 * user entries are in the window. Without this, a long all-assistant tail
 * (one big tool-heavy turn) pushes every user message beyond the budget —
 * the a39ee3d9 supersede sat 39,752 rendered chars back against a 30,000
 * budget — so the extractor never sees the task transition and
 * anchor_completed / anchor_revoked can never fire; the stale
 * first-user-message pin keeps steering the model.
 * @param {string} transcriptPath
 * @param {number} [budgetChars=30000]
 * @param {object} [opts]
 * @param {number} [opts.maxChars] hard cap on the extended window (default 3× budget)
 * @param {number} [opts.minUserEntries] user entries the window must contain (default 2)
 * @returns {string} compact text (empty string when nothing usable)
 */
function extractTranscriptTail(transcriptPath, budgetChars = 30000, opts = {}) {
  if (!transcriptPath) return '';
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.split('\n').filter(Boolean);
  const maxChars = Math.max(budgetChars, opts.maxChars || budgetChars * 3);
  const minUserEntries = Math.max(1, opts.minUserEntries || 2);
  const rendered = [];
  let used = 0;
  let userEntries = 0;
  for (let i = lines.length - 1; i >= 0 && used < maxChars; i--) {
    let text = null;
    let isUser = false;
    try {
      const entry = JSON.parse(lines[i]);
      text = entryToText(entry);
      isUser = entry.type === 'user';
    } catch {}
    if (!text) continue;
    rendered.unshift(text);
    used += text.length + 1;
    if (isUser) userEntries++;
    // Stop early only once BOTH the budget and the user-message guarantee
    // hold; otherwise keep walking back (bounded by maxChars).
    if (used >= budgetChars && userEntries >= minUserEntries) break;
  }
  return rendered.join('\n');
}

/**
 * Read the transcript DELTA — the entries appended after a previous
 * extraction (fromBytes = the transcript size at that extraction, the
 * `last_extraction_transcript_bytes` offset). The transcript JSONL is
 * append-only (qwen only appends a `chat_compression` record on
 * compaction), so the byte offset is a stable "since" marker and only the
 * window [fromBytes, size) is read — no full-file scan.
 *
 * Why: the Stop-hook extraction sends the whole tail (up to TAIL_MAX_CHARS,
 * ~90k chars ≈ 20k+ tokens) every time, and the 8089 extractor prefills at
 * ~300 tok/s — a full turn's worth of tool calls meant 40-60s LLM calls,
 * which collided with the user's next message and lost the trigger to the
 * stale-worker guard. A delta is usually one turn (a few k tokens): seconds,
 * not minutes. The current Σ is passed in the prompt, so the snapshot
 * (replace) semantics do not need the older content.
 *
 * If the window exceeds maxChars (pathological: first extraction of a long
 * session, or many stale-skipped turns accumulated), keep the TAIL of the
 * window — same coverage bound as extractTranscriptTail's budget, and the
 * dropped head is older than the last Σ snapshot anyway.
 * @param {string} transcriptPath
 * @param {number} fromBytes - byte offset to start after (0 = from beginning)
 * @param {object} [opts]
 * @param {number} [opts.maxChars=30000] - max window size (tail of window kept)
 * @returns {string} rendered entries ('' when nothing new / unreadable)
 */
function extractTranscriptDelta(transcriptPath, fromBytes, opts = {}) {
  if (!transcriptPath) return '';
  const maxChars = Math.max(1000, Number(opts.maxChars) || 30000);
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return '';
  }
  try {
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, Math.min(Number(fromBytes) || 0, size));
    let start = from;
    let capped = false;
    if (size - start > maxChars) {
      start = size - maxChars;
      capped = true;
    }
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (capped) {
      // `start` lands mid-line; drop the partial first line.
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    const rendered = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const t = entryToText(entry);
      if (t) rendered.push(t);
    }
    return rendered.join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Extract the verbatim last user message from a transcript JSONL — the
 * post-compaction ground truth for the current task. Scans the entries from
 * the end and returns the text of the most recent `type === 'user'` entry
 * with real user text parts. Tool results are their own
 * `type: 'tool_result'` entries, so the type filter already excludes them.
 * Two client-side wrappers are stripped so the result is the user's actual
 * words: the `[User message received during tool execution]:` prefix
 * (mid-execution sends) and attachment metadata parts ("User attachment
 * stored on the daemon host..."). The full file is read, not a tail window:
 * the message this hook recovers is the one before the compaction, which can
 * sit hundreds of KB back after a long tool-only stretch — and the hook runs
 * once per compaction, off the per-turn hot path. Fail-open: '' when the
 * transcript has no user entry or is unreadable.
 * @param {string} transcriptPath
 * @param {number} [maxChars=400] - max chars of the returned message
 * @returns {string} verbatim user message (clipped)
 */
function extractLastUserMessage(transcriptPath, maxChars = 400) {
  if (!transcriptPath) return '';
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== 'user' || !entry.message || !Array.isArray(entry.message.parts)) continue;
    const texts = entry.message.parts
      .map((p) => (p && typeof p.text === 'string' ? p.text.trim() : ''))
      .filter((t) => t && !/^User attachment stored on the daemon host/i.test(t));
    if (!texts.length) continue; // metadata-only user entry
    let msg = texts.join('\n');
    msg = msg.replace(/^\[User message received during tool execution\]:\s*/i, '');
    return clip(msg, Math.max(100, Number(maxChars) || 400));
  }
  return '';
}

// ─── SUMMARY_LLM extraction ───────────────────────────────────────────────

/**
 * Build the state-patch extraction prompt. Asks for a JSON patch only —
 * explicitly not a prose summary (the point of SKILL.state).
 * Decision items carry their rationale (why, rejected alternatives,
 * constraints), not just the what: post-compaction the session's
 * chain-of-thought is gone (reasoning retention is disabled server-side),
 * so each decision must be self-contained for the next session to act on.
 * Thinking is handled at the API layer (see callSummaryLLM): the model is
 * allowed to think, but the reasoning comes back in a separate
 * `reasoning_content` field that we discard — only the clean JSON `content`
 * is used. This is more reliable than the in-prompt /no_think token, which
 * the 27B model intermittently ignored (leaking chain-of-thought into the
 * JSON and breaking it).
 * @param {object} sigma - current Σ (may be {})
 * @param {string} transcriptText - compact transcript tail
 * @param {string} [sessionId] - the current session's id (cross-session isolation rule)
 * @returns {string}
 */
function buildExtractionPrompt(sigma, transcriptText, sessionId) {
  // Show the model only the content-relevant keys (the three sections + the
  // sticky anchor flags) — bookkeeping (token counts, offsets, kv_state) and
  // the mechanical recall_pointers are noise for the extractor.
  const view = {};
  for (const k of ['confirmed', 'hypothesis', 'next', 'blocked', 'anchor_revoked', 'anchor_completed']) {
    if (sigma[k] !== undefined) view[k] = sigma[k];
  }
  const current = Object.keys(view).length ? JSON.stringify(view, null, 2) : '{}';
  return `You are a state extractor for a coding-agent session that is about to be compacted.
Extract ONLY the structured execution state needed to continue the work after compaction.
Do NOT write prose. Do NOT summarize the conversation. Output a single JSON object only.

[Current State (Σ)]:
${current}

[Recent Conversation]:
${transcriptText}

[Output Schema] — a state patch; omit keys that did not change, set a key to null to delete it:
{
  "confirmed": ["verified fact — file:line"],
  "hypothesis": ["unverified belief or open question"],
  "next": ["outstanding step, in execution order"],
  "blocked": ["currently active blocker — condition"],
  "anchor_revoked": "boolean — see the anchor_revoked rule",
  "anchor_completed": "boolean — see the anchor_completed rule"
}

[Rules]
- Three sections, each a SNAPSHOT of the current view: output the FULL current list (carry forward items from the current state that are still true, add new ones, drop ones that are stale or done), or omit the key entirely if unchanged. Never output only the new items.
- confirmed: facts VERIFIED by a tool call in this segment or the current state (an edit/write that succeeded, a test run, a file read). EVERY item MUST end with a \`file:line\` citation of where the fact lives (for test/verification facts, the test or script file). If the conversation shows a previously confirmed fact is now stale (the code changed), drop or rewrite it.
- hypothesis: beliefs NOT yet verified by a tool call — suspected causes, expected-but-untested outcomes, open questions. No speculation beyond what the conversation suggests.
- next: steps still to be done, in execution order, each self-contained (a future reader must understand it without the chain-of-thought, which is NOT preserved after compaction). If the recent conversation shows the task CHANGED — a new user request, a pivot, or the previous task COMPLETED — you MUST output the updated next list: a finished or superseded task that lingers in Σ gets re-injected as the next turn's anchor and the model resumes it instead of the user's new message. Omit only when you are confident nothing changed; when in doubt, output the updated list.
- blocked: currently active blockers — actions that must NOT be retried until the condition clears (e.g. 'apachectl restart — user approval required', 'test suite failing: X — fix before deploy'). Format: \`<what> — <condition>\`. Omit or empty when nothing is blocked. At most 3 items, each at most 12 words.
- BUDGET: the whole patch must fit in about 800 tokens. confirmed at most 10 items, hypothesis at most 5, next at most 5, blocked at most 3; each item at most 20 words. When over budget, keep the most actionable items.
- anchor_revoked: set true ONLY when the user explicitly cancels, rejects, or supersedes the session's ORIGINAL first request in the recent conversation (e.g. "I never asked you to restore that — delete it again"). A follow-up, refinement, or new sub-task within the same task is NOT a revocation. It is sticky: if the current state is already true, keep it true. Omit it when unchanged.
- anchor_completed: set true when the recent conversation shows the session's ORIGINAL first request is FULLY COMPLETED — the work the user originally asked for is done (the deliverable exists, the tests pass, or the user has visibly moved on). It does NOT require a new task to have started: once the original work is done, the first-user-message pin has served its purpose and is released. A task that is only PARTIALLY done or still being actively worked on is NOT anchor_completed. It is sticky: if the current state is already true, keep it true. Omit it when unchanged.
- anchor-done next guard: if the current state or the recent conversation shows the ORIGINAL task is already completed or revoked (anchor_completed / anchor_revoked true), the \`next\` list must NOT re-list steps of that finished task — those belong in \`confirmed\` (as verified outcomes) only. If a NEW task is underway, \`next\` lists only the new task's steps; if nothing new is underway, omit \`next\` entirely.
- Latest-request alignment: the LATEST user message in the recent conversation defines the current task. If it starts or changes the task, \`next\` lists only that task's outstanding steps — steps of an older task that linger in the current state are dropped from \`next\` (verified outcomes of a finished task belong in \`confirmed\`).
- Cross-session isolation: this session is \`${sessionId || 'unknown'}\`. A path like \`state/<session-id>.json\` whose id does not match it cites ANOTHER session's state — omit any confirmed / hypothesis / next item that cites such a foreign file or whose only support is that file's content.
- Use only facts present in the conversation. No speculation.
- Grounding (anti-confabulation): an assistant message can CLAIM work it never did — citing files that no [call]/[result] line in this segment touched, or items "carried over from a previous session" with no tool-call evidence. A fact is confirmed only when a tool call in this segment (or the current state) shows it. Omit any confirmed / hypothesis / next item whose only support is such an unsupported claim.
- Output JSON only. No markdown fences, no commentary.`;
}

/**
 * Call the extraction LLM (OpenAI-compatible /v1/chat/completions).
 * Model cascade: SUMMARY_LLM (the lightweight model) first — a small model
 * that does NOT contend for slots on the main llama-server serving live
 * sessions; then MAIN_LLM; then the local default. SUMMARY_LLM is also the
 * shared lightweight model for the MCP-side topic-key / prune / relevance
 * filters (lib/utils.js), so repointing it in .env moves extraction and
 * those together.
 *
 * enable_thinking: true — the Qwen3 27B model intermittently ignores the
 * in-prompt /no_think token and leaks chain-of-thought into the JSON,
 * breaking it. Enabling thinking at the API level instead routes the
 * reasoning into a separate `reasoning_content` field; we discard it and
 * use only the clean JSON in `content`. The configured URL is a
 * /v1/completions endpoint; the chat endpoint is derived by swapping the
 * suffix (the same OpenAI-compatible server serves both).
 * @param {string} prompt
 * @param {number} [timeoutMs=120000]
 * @returns {Promise<string>} the JSON `content` ('' on any failure)
 */
async function callSummaryLLM(prompt, timeoutMs = 120000) {
  const completionsUrl = env('SUMMARY_LLM_URL', env('MAIN_LLM', 'http://127.0.0.1:8081/v1/completions'));
  const url = /\/chat\/completions$/.test(completionsUrl)
    ? completionsUrl
    : completionsUrl.replace(/\/completions$/, '/chat/completions');
  const model = env('SUMMARY_LLM_MODEL', env('MAIN_LLM_MODEL', 'summary-27b'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // max_tokens 4096: the patch content is capped at ~800 tokens by the
      // prompt budget; 4096 leaves headroom for thinking tokens (which share
      // the budget on these servers) without allowing a runaway patch.
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        enable_thinking: true,
        temperature: 0.1,
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });
    if (res.status !== 200) {
      console.error(`[skillstate] LLM HTTP ${res.status}`);
      return '';
    }
    const data = await res.json();
    const m = data.choices && data.choices[0] && data.choices[0].message;
    const t = m && m.content;
    return typeof t === 'string' ? t : ''; // contract: string, never a Promise/object
  } catch (err) {
    console.error(`[skillstate] LLM error: ${err.name === 'AbortError' ? `timeout (${timeoutMs}ms)` : err.message}`);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Completion-signal patterns for the mechanical task-switch flip
 * (2026-10-15 stale-anchor incident). A superset of check-writeback.js's
 * COMPLETION_PATTERNS — same conservative base set, intentionally NOT shared
 * (check-writeback gates a user-facing ask and must not pick up new
 * patterns) plus commit/push-completion patterns: the incident's actual
 * completion signal ("커밋·푸시 완료") falls outside the check-writeback set.
 * Matched against the turn's final assistant message at Stop; the flag it
 * sets is consumed by the UserPromptSubmit hook's flip, so a false positive
 * costs at most one turn of state re-derivation (the flip marks the ORIGINAL
 * anchor done and wipes the current view, which the next extraction
 * re-derives from the live transcript).
 */
const COMPLETION_SIGNAL_PATTERNS = [
  /테스트.*통과|all checks?\s*pass/i,
  /버그?.*수정|bug.{0,5}fix|fixed the bug/i,
  /기능.*완성|구현 완료|feature delivered|implementation complete/i,
  /ready to commit|커밋.?해줘|commit this/i,
  /done with the changes|작업 완료|수정 완료/i,
  // Commit/push completion (the 2026-10-15 incident's signal) —
  // check-writeback's set predates it.
  /커밋[하하고]*[·\s]?푸시|커밋.{0,8}완료|푸시.{0,8}완료/i,
  /committed and pushed|successfully pushed/i,
];

/**
 * True when the given (final) assistant message carries a completion signal.
 * The Stop hook uses it to set sigma.last_turn_completion_signal; the
 * UserPromptSubmit hook consumes that flag as a mechanical anchor flip.
 * @param {string} message - the turn's final assistant message
 * @returns {boolean}
 */
function completionSignal(message) {
  if (typeof message !== 'string' || !message.trim()) return false;
  return COMPLETION_SIGNAL_PATTERNS.some((p) => p.test(message));
}

const SCHEMA_KEYS = ['confirmed', 'hypothesis', 'next', 'blocked', 'anchor_revoked', 'anchor_completed'];

/**
 * Unwrap a {"state_patch": {...}} envelope if present.
 * @param {object} p
 * @returns {object}
 */
function unwrapPatch(p) {
  if (p && typeof p === 'object' && p.state_patch && typeof p.state_patch === 'object') return p.state_patch;
  return p;
}

/**
 * Extract the state-patch JSON object from LLM output. Tolerates markdown
 * fences, thinking preambles, and trailing commentary. Scans all balanced
 * top-level brace candidates (string/escape aware) and prefers ones
 * containing schema keys, trying the LAST candidate first (the final answer
 * usually comes after any mid-text examples).
 * @param {string} text
 * @returns {object|null}
 */
function extractJsonPatch(text) {
  if (typeof text !== 'string' || !text) return null; // defensive: never throw on non-string
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidate = fence[1].trim();

  const balanced = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        balanced.push(candidate.slice(start, i + 1));
        start = -1;
      }
    }
  }

  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const isObject = (p) => p !== null && typeof p === 'object' && !Array.isArray(p);
  const hasSchemaKey = (p) => isObject(p) && (p.state_patch !== undefined || SCHEMA_KEYS.some((k) => k in p));

  let p = tryParse(candidate);
  if (hasSchemaKey(p)) return unwrapPatch(p);
  // Final answer first: scan candidates right-to-left
  for (let i = balanced.length - 1; i >= 0; i--) {
    p = tryParse(balanced[i]);
    if (hasSchemaKey(p)) return unwrapPatch(p);
  }
  for (let i = balanced.length - 1; i >= 0; i--) {
    p = tryParse(balanced[i]);
    if (isObject(p)) return p;
  }
  return null;
}

/**
 * Emit a hook JSON output on stdout.
 * @param {object} hookSpecificOutput
 */
function emitHookOutput(hookSpecificOutput) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

/**
 * Normalize a next-item for overlap comparison (lowercase, word chars only —
 * keeps CJK so Korean steps compare correctly).
 * @param {string} s
 * @returns {string}
 */
function normItem(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9가-힣]+/g, ' ').trim();
}

/**
 * Word-token Jaccard similarity between two next-items.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
function itemSimilarity(a, b) {
  const ta = new Set(normItem(a).split(' ').filter(Boolean));
  const tb = new Set(normItem(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

/**
 * Fraction of incoming next-items that resemble a baseline item (the
 * re-derivation signal). >= 0.5 means the incoming list is mostly the SAME
 * task's steps (a stale re-derivation); < 0.5 means it is a genuinely new task.
 * @param {string[]} incoming
 * @param {string[]} baseline
 * @returns {number} 0..1 (0 when either list is empty)
 */
function nextOverlapRatio(incoming, baseline) {
  const inc = (incoming || []).filter((x) => typeof x === 'string' && x.trim());
  const base = (baseline || []).filter((x) => typeof x === 'string' && x.trim());
  if (!inc.length || !base.length) return 0;
  let matched = 0;
  for (const item of inc) {
    let best = 0;
    for (const b of base) {
      const sim = itemSimilarity(item, b);
      if (sim > best) best = sim;
    }
    if (best >= 0.4) matched++;
  }
  return matched / inc.length;
}

/**
 * Anchor-done gate action for an incoming `next` patch (2026-10-20 stale-anchor
 * fix). The 2026-10-15 gate only ever STRIPPED next (preserving the current
 * list), which — combined with sticky anchor_completed and no reset-arming in
 * evict-extract — FROZE a stale next indefinitely. This adds a RELEASE action:
 *   'none'    — anchor not done, or no next in the patch: merge normally.
 *   'strip'   — anchor done and the incoming next re-derives the completed
 *               task's steps (high overlap with the baseline): omit next from
 *               the patch so the current list is preserved (the 2026-10-15
 *               stale-anchor protection).
 *   'release' — anchor done but the incoming next is a genuinely NEW task
 *               (low overlap with the baseline, or no baseline): the
 *               completed/revoked anchor is stale (premature flip or a
 *               superseded task). Release it so the new task runs under a clean
 *               anchor instead of a "COMPLETED + new work" framing.
 * @param {object} cur - the current Σ (before merge)
 * @param {object} patch - the incoming patch
 * @returns {{action: 'none'|'strip'|'release'}}
 */
function anchorDoneGateAction(cur, patch) {
  const anchorDone = cur.anchor_completed === true || cur.anchor_revoked === true;
  if (!anchorDone || !Object.prototype.hasOwnProperty.call(patch, 'next')) return { action: 'none' };
  const incoming = (Array.isArray(patch.next) ? patch.next : []).filter((x) => typeof x === 'string' && x.trim());
  if (!incoming.length) return { action: 'none' };
  const baseline = (Array.isArray(cur.anchor_done_next) && cur.anchor_done_next.length)
    ? cur.anchor_done_next
    : (Array.isArray(cur.next) ? cur.next : []);
  if (!baseline.length) return { action: 'release' }; // no completed-task baseline → new task
  return { action: nextOverlapRatio(incoming, baseline) >= 0.5 ? 'strip' : 'release' };
}

module.exports = {
  SIGMA_DIR,
  skillStateEnabled,
  env,
  sigmaFile,
  loadSigma,
  saveSigma,
  mutateSigma,
  setSigmaNote,
  stampActiveSession,
  resolveActiveSession,
  freshestSigmaSession,
  bumpCompactCount,
  sweepSigma,
  mergeSigma,
  completionSignal,
  filterGhostRefs,
  foreignSessionRefs,
  filterForeignSessionRefs,
  scrubSigmaForeignRefs,
  SCHEMA_KEYS,
  digestTranscript,
  renderAnchor,
  extractTranscriptTail,
  extractTranscriptDelta,
  extractLastUserMessage,
  buildExtractionPrompt,
  callSummaryLLM,
  extractJsonPatch,
  emitHookOutput,
  appendTelemetry,
  anchorDoneGateAction,
  nextOverlapRatio,
};
