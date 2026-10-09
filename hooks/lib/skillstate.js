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
const crypto = require('crypto');
const { withLock, atomicWrite, appendTelemetry, STATE_DIR } = require('./state.js');

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

// ─── Per-Stop state-change detection + anchor rendering ─────────────────

// Tool calls that mechanically change execution state — their presence in
// the tool-call JSONL since the last extraction is the primary per-Stop
// trigger (prose-only turns rarely move state and must not pay an LLM call).
const MUTATING_TOOLS = new Set(['edit', 'write_file', 'remember_decision']);

/**
 * True when the session's tool-call JSONL (lib/state.js STATE_DIR) has a
 * mutating tool call appended after `fromBytes` bytes. The log is
 * append-only per session and rotated in place once over 512KB — a file
 * smaller than `fromBytes` was rotated, so the whole file counts as fresh.
 * A slice starting mid-line (concurrent append between stat and read) just
 * fails JSON.parse on that fragment and is skipped (fail-open: the 50k
 * context-growth fallback still fires when it matters).
 * @param {string} sessionId
 * @param {number} [fromBytes=0] byte offset of the last extraction
 * @returns {boolean}
 */
function hasMutatingCallsSince(sessionId, fromBytes = 0) {
  const file = path.join(STATE_DIR, `${sessionId}.jsonl`);
  try {
    const size = fs.statSync(file).size;
    const offset = size < fromBytes ? 0 : fromBytes;
    if (size <= offset) return false;
    const len = Math.min(size - offset, 256 * 1024); // cap the per-Stop scan
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8').split('\n').some((line) => {
        if (!line) return false;
        try {
          return MUTATING_TOOLS.has(JSON.parse(line).tool);
        } catch {
          return false;
        }
      });
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Detect a new REAL user message in the transcript since the last extraction
 * (trigger 3 for the Stop hook). The transcript JSONL is append-only and keeps
 * its full history across compactions (qwen only appends a `chat_compression`
 * record), so a byte offset is a stable "since" marker. Real user messages are
 * entries with type "user" and a text part; tool results are a separate entry
 * type ("tool_result" with functionResponse parts), so they never count.
 *
 * Why: triggers 1 (mutating tool call) and 2 (50k context growth) both miss
 * prose-only turns — which is exactly where task changes and CANCELLATIONS
 * arrive. 2026-09-28 incident: the cancellation turn ("복구하라고 한적이
 * 없다") was prose-only, so Σ — and the pin-release flag derived from it —
 * went stale while the pinned cancelled request kept steering the model.
 * @param {string} transcriptPath
 * @param {number} [fromBytes=0] byte offset of the last extraction
 * @returns {boolean}
 */
function hasNewUserMessageSince(transcriptPath, fromBytes = 0) {
  if (!transcriptPath) return false;
  try {
    const size = fs.statSync(transcriptPath).size;
    const offset = size < fromBytes ? 0 : fromBytes;
    if (size <= offset) return false;
    // Read the ENTIRE new region, not a tail window: the transcript is
    // chronological, so the new user message sits at the START of the region
    // (hasMutatingCallsSince may tail-scan because a mutation anywhere in the
    // window counts — here only the head matters). The region is one turn:
    // the offset re-baselines at every firing Stop, and every turn begins
    // with a user message.
    const len = size - offset;
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      return buf.toString('utf8').split('\n').some((line) => {
        if (!line) return false;
        try {
          const e = JSON.parse(line);
          if (e.type !== 'user') return false;
          return Array.isArray(e.message && e.message.parts) &&
            e.message.parts.some((p) => typeof p.text === 'string' && p.text.length > 0);
        } catch {
          return false;
        }
      });
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
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

  // 2026-10-09 three-section schema: confirmed (verified, file:line) /
  // hypothesis (unverified) / next (outstanding steps). next first — it is
  // what the next turn acts on; confirmed second — the verified ground the
  // action relies on; hypothesis last — the least trustworthy.
  const strList = (k) => (Array.isArray(sigma[k]) ? sigma[k].filter((x) => typeof x === 'string' && x.trim()) : []);
  const next = strList('next');
  const confirmed = strList('confirmed');
  const hypothesis = strList('hypothesis');
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
    parts.push(`recall: ${n} offloaded segment(s) from before compaction are re-loadable via <focus> (see the offloaded-chunks note)${hint}`);
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
};
// Per-section item caps — keep Σ within the ~800-token injection budget.
const SECTION_CAPS = { confirmed: 10, hypothesis: 5, next: 5 };
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
  for (const key of ['confirmed', 'hypothesis', 'next']) {
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
 * @returns {string}
 */
function buildExtractionPrompt(sigma, transcriptText) {
  // Show the model only the content-relevant keys (the three sections + the
  // sticky anchor flags) — bookkeeping (token counts, offsets, kv_state) and
  // the mechanical recall_pointers are noise for the extractor.
  const view = {};
  for (const k of ['confirmed', 'hypothesis', 'next', 'anchor_revoked', 'anchor_completed']) {
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
  "anchor_revoked": "boolean — see the anchor_revoked rule",
  "anchor_completed": "boolean — see the anchor_completed rule"
}

[Rules]
- Three sections, each a SNAPSHOT of the current view: output the FULL current list (carry forward items from the current state that are still true, add new ones, drop ones that are stale or done), or omit the key entirely if unchanged. Never output only the new items.
- confirmed: facts VERIFIED by a tool call in this segment or the current state (an edit/write that succeeded, a test run, a file read). EVERY item MUST end with a \`file:line\` citation of where the fact lives (for test/verification facts, the test or script file). If the conversation shows a previously confirmed fact is now stale (the code changed), drop or rewrite it.
- hypothesis: beliefs NOT yet verified by a tool call — suspected causes, expected-but-untested outcomes, open questions. No speculation beyond what the conversation suggests.
- next: steps still to be done, in execution order, each self-contained (a future reader must understand it without the chain-of-thought, which is NOT preserved after compaction). If the recent conversation shows the task CHANGED — a new user request, a pivot, or the previous task COMPLETED — you MUST output the updated next list: a finished or superseded task that lingers in Σ gets re-injected as the next turn's anchor and the model resumes it instead of the user's new message. Omit only when you are confident nothing changed; when in doubt, output the updated list.
- BUDGET: the whole patch must fit in about 800 tokens. confirmed at most 10 items, hypothesis at most 5, next at most 5; each item at most 20 words. When over budget, keep the most actionable items.
- anchor_revoked: set true ONLY when the user explicitly cancels, rejects, or supersedes the session's ORIGINAL first request in the recent conversation (e.g. "I never asked you to restore that — delete it again"). A follow-up, refinement, or new sub-task within the same task is NOT a revocation. It is sticky: if the current state is already true, keep it true. Omit it when unchanged.
- anchor_completed: set true when the recent conversation shows the session's ORIGINAL first request is FULLY COMPLETED — the work the user originally asked for is done (the deliverable exists, the tests pass, or the user has visibly moved on). It does NOT require a new task to have started: once the original work is done, the first-user-message pin has served its purpose and is released. A task that is only PARTIALLY done or still being actively worked on is NOT anchor_completed. It is sticky: if the current state is already true, keep it true. Omit it when unchanged.
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

const SCHEMA_KEYS = ['confirmed', 'hypothesis', 'next', 'anchor_revoked', 'anchor_completed'];

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

// ─── work_memory dual-write ───────────────────────────────────────────────

/**
 * Deterministic point ID for a session's state_checkpoint — Qdrant accepts
 * only positive ints or UUIDs, so the sha256 of a session-scoped key is
 * formatted as a UUID (8-4-4-4-12). Per-Stop extraction would otherwise
 * create a fresh near-identical work_memory point every turn (flooding);
 * with a stable ID each session owns exactly one checkpoint point that is
 * upserted in place.
 * @param {string} sessionId
 * @returns {string} UUID-formatted point ID
 */
function checkpointId(sessionId) {
  const h = crypto.createHash('sha256').update(`state_checkpoint:${sessionId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Embed text via the local BGE server.
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function embedText(text) {
  const url = env('BGE_URL', 'http://127.0.0.1:8080/v1/embeddings');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'bge-m3', input: text }),
      signal: controller.signal,
    });
    if (res.status !== 200) return null;
    const data = await res.json();
    if (data.data && Array.isArray(data.data) && data.data[0]) return data.data[0].embedding;
    if (data.embedding) return data.embedding;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persist a Σ snapshot to the work_memory collection (type "state_checkpoint")
 * so future sessions can auto-recall the last known execution state.
 * Best-effort — any failure is swallowed (the Σ file is the source of truth).
 * @param {object} sigma
 * @param {string} [cwd]
 * @param {string} [trigger]
 * @returns {Promise<boolean>} true when the point was upserted
 */
// One-line human summary of a Σ for the work_memory checkpoint. Prefers the
// first outstanding step (the actionable part); falls back to a confirmed
// fact, then the legacy task_summary.
function checkpointSummaryLine(sigma) {
  const next = Array.isArray(sigma.next) ? sigma.next.find((x) => typeof x === 'string' && x.trim()) : null;
  if (next) return next;
  const confirmed = Array.isArray(sigma.confirmed) ? sigma.confirmed.find((x) => typeof x === 'string' && x.trim()) : null;
  if (confirmed) return confirmed;
  return sigma.task_summary || '(no state)';
}

// Distinct file paths cited in Σ — file:line refs from confirmed items first
// (the new schema), legacy files_touched as fallback.
function checkpointRelatedFiles(sigma) {
  const out = [];
  const push = (f) => { if (f && !out.includes(f)) out.push(f); };
  const refRe = /([A-Za-z0-9._\-/]+\.\w+):(\d+)/g;
  for (const item of Array.isArray(sigma.confirmed) ? sigma.confirmed : []) {
    for (const m of String(item).matchAll(refRe)) push(m[1]);
  }
  for (const f of Array.isArray(sigma.files_touched) ? sigma.files_touched : []) push(f);
  return out.slice(-MAX_LIST_ITEMS);
}

async function recordCheckpoint(sigma, cwd, trigger) {
  const qdrantUrl = env('QDRANT_URL', 'http://127.0.0.1:6333').replace(/\/$/, '');
  const summary = `SKILL.state checkpoint [${trigger || 'compact'}]: ${checkpointSummaryLine(sigma)}`;
  const vector = await embedText(summary);
  if (!vector) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    // PUT, not POST: this Qdrant build treats POST /points as a different
    // endpoint ("missing field `ids`"); PUT is the upsert method here.
    const res = await fetch(`${qdrantUrl}/collections/work_memory/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: [
          {
            // Stable per-session ID: one upserted point, not one per extraction
            id: sigma.session_id ? checkpointId(sigma.session_id) : crypto.randomUUID(),
            vector,
            payload: {
              type: 'state_checkpoint',
              project: cwd ? path.basename(cwd) : '',
              summary_text: summary,
              detail: JSON.stringify(sigma),
              related_files: checkpointRelatedFiles(sigma),
              status: 'open',
              timestamp: new Date().toISOString(),
            },
          },
        ],
      }),
      signal: controller.signal,
    });
    return res.status === 200 || res.status === 201 || res.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Emit a hook JSON output on stdout.
 * @param {object} hookSpecificOutput
 */
function emitHookOutput(hookSpecificOutput) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

module.exports = {
  SIGMA_DIR,
  skillStateEnabled,
  env,
  sigmaFile,
  loadSigma,
  saveSigma,
  mutateSigma,
  bumpCompactCount,
  sweepSigma,
  mergeSigma,
  filterGhostRefs,
  SCHEMA_KEYS,
  hasMutatingCallsSince,
  hasNewUserMessageSince,
  renderAnchor,
  checkpointId,
  extractTranscriptTail,
  extractTranscriptDelta,
  buildExtractionPrompt,
  callSummaryLLM,
  extractJsonPatch,
  recordCheckpoint,
  emitHookOutput,
  appendTelemetry,
};
