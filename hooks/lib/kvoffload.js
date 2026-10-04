// KV offload durable store for FocusMemory (CJS — hooks/ scope).
//
// Backs the focus-llama kv-offload feature (plans/focus-offload.md): when the
// engine's prompt exceeds --kv-offload-threshold, it evicts the oldest DA
// chunk by (1) PUT-ing the chunk's raw text here and (2) removing the chunk's
// KV range. When the model later emits <focus magic_chunks="N"> targeting an
// evicted chunk, the engine GETs the text back and re-prefills it.
//
// This module is a DUMB store. It does not decide what to evict or when —
// that judgment (and the physical KV removal / re-prefill) lives in the
// focus-llama engine, which owns the KV cache. FocusMemory only persists the
// text the engine hands it, keyed by (session_id, chunk_id), and returns it
// verbatim on request.
//
// Storage: one JSON file per session at
//   ~/.qwen/tmp/focus-memory/kv-offload/<session_id>.json
// shaped { session_id, updated_at, chunks: { "<chunk_id>": {text, tokens, ts} } }.
// Per-session JSON (not append-only JSONL) because individual chunks are
// upserted/removed in place; it mirrors skillstate.js's per-session Σ file and
// reuses state.js's withLock/atomicWrite so concurrent engine PUT/GET can
// never observe a torn file (rename is atomic; a lock-free read still sees
// either the old or the new whole file).
//
// Everything here is fail-open by design: a store error must never take down
// the HTTP server or block the engine. put/get return a status object; the
// engine treats a failed GET as fail-open (proceed without the chunk),
// consistent with the DA marker/drift fail-open principle.
//
// Feature gate: FOCUSMEMORY_KVOFFLOAD=on (any other value / unset → the HTTP
// routes return 404 and the store is inert). Read from process.env: the HTTP
// server (index.js) loads FocusMemory/.env via dotenv before any route runs,
// so the gate is resolved there. (Unlike the qwen-spawned hooks, this store is
// only reached over HTTP, so it does not need skillstate.js's manual .env
// parse.)

const fs = require('fs');
const path = require('path');
const { withLock, atomicWrite } = require('./state.js');

const HOME = process.env.HOME || process.env.USERPROFILE || '.';
const KV_DIR = path.join(HOME, '.qwen', 'tmp', 'focus-memory', 'kv-offload');
fs.mkdirSync(KV_DIR, { recursive: true });

// 치환 매핑 테이블 (원본 태그 : 치환될 문자열)
const TAG_REPLACEMENTS = {
  // Reasoning / Thinking 태그
  "<think>": "[past_think]",
  "</think>": "[past_end_think]",

  // Tool Call & Tool Response 태그
  "<tool_call>": "[past_tool_call]",
  "</tool_call>": "[past_end_tool_call]",
  "<function=": "[past_function=",
  "</function>": "[past_end_function]",
  "<parameter=": "[past_parameter=",
  "</parameter>": "[past_end_parameter]",
  "<tool_response>": "[past_tool_response]",
  "</tool_response>": "[past_end_tool_response]",

  // ChatML & 특수 제어 태그
  "<|im_start|>": "[past_im_start]",
  "<|im_end|>": "[past_im_end]",
  "<|endoftext|>": "[past_endoftext]",

  "<qwen:user-prompt-submit-context>": "[past_user_prompt_submit_context]",
  "</qwen:user-prompt-submit-context>": "[past_end_user_prompt_submit_context]",
  "<qwen:tool-result>": "[past_tool_result]",
  "</qwen:tool-result>": "[past_end_tool_result]",
  "<system-reminder>": "[past_system_reminder]",
  "</system-reminder>": "[past_end_system_reminder]",

  "<function_results>": "[past_function_results]",
  "</function_results>": "[past_end_function_results]",
  
  // Focus 태그 재귀 트리거 방지
  "<focus>": "[past_focus]",
  "</focus>": "[past_end_focus]",
  "<global>": "[past_global]",
  "</global>": "[past_end_global]",
  "<invoke>": "[past_invoke]",
  "</invoke>": "[past_end_invoke]"
};

// 정규식 특수문자 이스케이프 함수
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 매핑 키들을 모아서 단일 정규식 패턴 생성 (예: /<think>|<\/think>|<tool_call>|.../g)
const tagPattern = new RegExp(
  Object.keys(TAG_REPLACEMENTS).map(escapeRegExp).join('|'),
  'g'
);

/**
 * 텍스트 내부의 LLM 제어 태그들을 안전하게 단일 패스로 치환합니다.
 * @param {string} text 
 * @returns {string}
 */
function sanitizeRefillText(text) {
  if (!text) return text;
  return text.replace(tagPattern, (matched) => TAG_REPLACEMENTS[matched]);
}

/**
 * Feature gate — true only when FOCUSMEMORY_KVOFFLOAD is exactly "on".
 * @returns {boolean}
 */
function kvOffloadEnabled() {
  return String(process.env.FOCUSMEMORY_KVOFFLOAD || '').toLowerCase() === 'on';
}

/**
 * Sanitize a session_id for use as a file name. Only [A-Za-z0-9_-] survive;
 * everything else becomes "_". Prevents path traversal if a malformed id ever
 * reaches the store (the engine sends a UUID, so this is defense in depth).
 * @param {string} sessionId
 * @returns {string} a safe file-stem (never empty, never a path separator)
 */
function safeSessionStem(sessionId) {
  const s = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '_');
  return s || 'default';
}

/**
 * Absolute path of a session's offload file.
 * @param {string} sessionId
 * @returns {string}
 */
function sessionFile(sessionId) {
  return path.join(KV_DIR, `${safeSessionStem(sessionId)}.json`);
}

/**
 * Read a session's offload doc; missing or corrupt file yields the empty shape.
 * @param {string} sessionId
 * @returns {{session_id: string, updated_at: string|null, chunks: Object<string, {text: string, tokens?: number, ts: string}>}}
 */
function loadDoc(sessionId) {
  const file = sessionFile(sessionId);
  try {
    if (fs.existsSync(file)) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc && typeof doc === 'object' && typeof doc.chunks === 'object' && doc.chunks !== null) {
        return doc;
      }
    }
  } catch {
    // corrupt file — fall through to the empty shape (fail-open)
  }
  return { session_id: String(sessionId || ''), updated_at: null, chunks: {} };
}

/**
 * Lock-protected read-modify-write of a session's offload doc.
 * @param {string} sessionId
 * @param {(doc: object) => object|null} mutate - returns the next doc, or null to skip the write
 * @returns {object|null} the doc as written (null when mutate skipped)
 */
function updateDoc(sessionId, mutate) {
  const file = sessionFile(sessionId);
  return withLock(file, () => {
    const doc = loadDoc(sessionId);
    const next = mutate(doc);
    if (next === null) return null;
    atomicWrite(file, JSON.stringify(next));
    return next;
  });
}

// ─── Evicted user-instruction ledger ────────────────────────────────────
// kv_offload_evict keeps the FIRST user message pinned in the KV (task
// anchor) and evicts the middle — which includes the user instructions that
// define, change, or CANCEL the task. The model then re-derives "what am I
// doing" from what remains: the pinned (possibly superseded) original
// request + recent work, with the intervening instructions invisible.
// 2026-09-28 incident: the evicted current-task definition + the pinned
// cancelled request produced a restore loop right after an explicit user
// cancellation ("복구하라고 한적이 없다").
//
// The ledger records the real user-instruction segments that left the KV so
// a client hook can re-surface them as history data in the evict-protected
// last-user region. Dumb + fail-open like the rest of this module: it
// stores what it can parse; interpretation is the model's.

const INSTR_CLIP = 300; // per-instruction clip (chars)
const INSTR_MAX = 15;   // ledger cap (most recent kept)

// First-line markers of user-role segments that are NOT real user
// instructions: tool results and hook-generated correction prompts.
const NOT_INSTRUCTION_RE = /^(?:<tool_response>|<tool_response>|\[FocusMemory ghost-file gate\])/;

/**
 * Strip client-appended context blocks (user-prompt-submit context, system
 * reminders) so the ledger keeps the user's own words.
 * @param {string} s
 * @returns {string}
 */
function stripInjectedBlocks(s) {
  return s
    .replace(/<qwen:user-prompt-submit-context>[\s\S]*?<\/qwen:user-prompt-submit-context>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

/**
 * Extract the real user-instruction segments from an evicted chunk's raw
 * text (chat-template role markers included). Tool results and hook
 * corrections are excluded; results are clipped, most recent last.
 * @param {string} text - the evicted segment's raw text
 * @returns {string[]} clipped instruction strings
 */
function extractUserInstructions(text) {
  const out = [];
  const re = /<\|im_start\|>user\n([\s\S]*?)(?=<\|im_start\|>|$)/g;
  for (const m of String(text).matchAll(re)) {
    let body = m[1].replace(/\s*<\|im_end\|>\s*$/, '').trim();
    if (!body) continue;
    if (NOT_INSTRUCTION_RE.test(body.split('\n', 1)[0])) continue;
    body = stripInjectedBlocks(body);
    if (!body) continue;
    out.push(body.length > INSTR_CLIP ? `${body.slice(0, INSTR_CLIP)}…` : body);
  }
  return out;
}

/**
 * Store (upsert) one segment's text for a session, and record any real
 * user-instruction segments it contains in the session's ledger.
 * @param {string} sessionId
 * @param {string} key - stable segment key (the engine's content hash)
 * @param {string} text - the segment's raw text (re-prefilled verbatim on GET)
 * @param {number} [tokens] - approximate token count (metadata, optional)
 * @returns {{ok: boolean, bytes?: number, reason?: string}}
 */
function putChunk(sessionId, key, text, tokens) {
  if (!kvOffloadEnabled()) return { ok: false, reason: 'disabled' };
  if (typeof text !== 'string' || text.length === 0) return { ok: false, reason: 'empty text' };
  const k = String(key);
  if (!k) return { ok: false, reason: 'empty key' };
  const instructions = extractUserInstructions(text);
  try {
    const doc = updateDoc(sessionId, (d) => {
      d.session_id = String(sessionId || '');
      d.updated_at = new Date().toISOString();
      d.chunks[k] = {
        text: sanitizeRefillText(text),
        tokens: Number.isFinite(tokens) ? Number(tokens) : undefined,
        ts: new Date().toISOString(),
      };
      if (instructions.length) {
        if (!Array.isArray(d.instructions)) d.instructions = [];
        for (const t of instructions) {
          // Text-keyed dedup: a chunk is PUT idempotently, and the same
          // instruction text must not accumulate duplicate ledger entries.
          if (!d.instructions.some((e) => e.text === t)) {
            d.instructions.push({ text: t, ts: new Date().toISOString() });
          }
        }
        if (d.instructions.length > INSTR_MAX) d.instructions = d.instructions.slice(-INSTR_MAX);
      }
      return d;
    });
    if (!doc) return { ok: false, reason: 'write skipped' };
    return { ok: true, bytes: Buffer.byteLength(text, 'utf8') };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * List a session's evicted user-instruction ledger (clipped text + ts,
 * oldest first). Read-only and gate-less by design: it is called from
 * qwen-spawned hook processes (no FocusMemory/.env in their environment),
 * and the ledger only ever contains data the engine actually PUT — a
 * missing/corrupt file simply yields [].
 * @param {string} sessionId
 * @returns {Array<{text: string, ts: string}>}
 */
function listInstructions(sessionId) {
  try {
    const doc = loadDoc(sessionId);
    return Array.isArray(doc.instructions) ? doc.instructions : [];
  } catch {
    return [];
  }
}

// ─── Pin-released flag (B4) ──────────────────────────────────────────────
// The engine pins the FIRST user message in the KV (task anchor — 2026-09-26
// fix), but a pinned STALE request keeps steering the model after the task
// is over (2026-09-28 incident: user revoked the task; 2026-10-02 incident
// cde14958: task completed and superseded by a newer request — the pinned
// original re-latched the model after its completion evidence was evicted).
// When the state worker judges the original task revoked (Σ.anchor_revoked)
// OR completed-and-superseded (Σ.anchor_completed) — both sticky — it
// mirrors the flag here; the engine reads it at its next eviction plan and
// the first user message becomes a normal evictable middle message
// (re-surfaced per turn by the instruction ledger above).

/**
 * Mark a session's first-user-message pin as released (idempotent, sticky —
 * once set it is never cleared; the session file is deleted at session end).
 * Gate-less by design: it is called from qwen-spawned worker processes that
 * have no FocusMemory/.env in their environment, and the flag is inert
 * unless the engine's own FOCUSMEMORY_KVOFFLOAD gate is on (the engine
 * simply never queries it).
 * @param {string} sessionId
 * @returns {{ok: boolean, reason?: string}}
 */
function setPinReleased(sessionId) {
  let set = false;
  try {
    const doc = updateDoc(sessionId, (d) => {
      if (d.pin_released === true) return null; // already released — no rewrite
      d.pin_released = true;
      d.pin_released_at = new Date().toISOString();
      d.updated_at = d.pin_released_at;
      set = true;
      return d;
    });
    // null doc = the mutator skipped the write because the flag was already
    // set (idempotent success); a doc = a fresh write.
    if (set || doc === null) return { ok: true };
    return { ok: false, reason: 'write skipped' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Read a session's pin-released flag (false when absent/corrupt — the
 * engine's fail-open default keeps the pin).
 * @param {string} sessionId
 * @returns {boolean}
 */
function getPinReleased(sessionId) {
  try {
    return loadDoc(sessionId).pin_released === true;
  } catch {
    return false;
  }
}

/**
 * Retrieve one chunk's text for a session.
 * @param {string} sessionId
 * @param {number} chunkId
 * @returns {{ok: boolean, text?: string, tokens?: number, ts?: string, reason?: string}}
 *   ok=false (reason 'not found' | 'disabled') is the engine's fail-open signal.
 */
function getChunk(sessionId, key) {
  if (!kvOffloadEnabled()) return { ok: false, reason: 'disabled' };
  const k = String(key);
  const doc = loadDoc(sessionId);
  const entry = doc.chunks[k];
  if (!entry || typeof entry.text !== 'string') return { ok: false, reason: 'not found' };
  return { ok: true, text: entry.text, tokens: entry.tokens, ts: entry.ts };
}

/**
 * List the chunks a session has offloaded (metadata only, no text).
 * @param {string} sessionId
 * @returns {Array<{chunk_id: number, tokens?: number, ts: string, bytes: number}>}
 */
function listChunks(sessionId) {
  const doc = loadDoc(sessionId);
  return Object.entries(doc.chunks)
    .map(([key, e]) => ({
      key,
      tokens: e.tokens,
      ts: e.ts,
      bytes: Buffer.byteLength(e.text || '', 'utf8'),
    }))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

/**
 * Remove one chunk from a session's offload doc.
 * @param {string} sessionId
 * @param {number} chunkId
 * @returns {{ok: boolean, removed?: boolean, reason?: string}}
 */
function deleteChunk(sessionId, key) {
  if (!kvOffloadEnabled()) return { ok: false, reason: 'disabled' };
  const k = String(key);
  let removed = false;
  try {
    const doc = updateDoc(sessionId, (d) => {
      if (d.chunks[k] === undefined) return null; // nothing to do
      delete d.chunks[k];
      d.updated_at = new Date().toISOString();
      removed = true;
      return d;
    });
    if (!doc && !removed) return { ok: false, reason: 'not found' };
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Delete a session's entire offload doc (cleanup on session end).
 * @param {string} sessionId
 * @returns {{ok: boolean, removedChunks?: number, reason?: string}}
 */
function deleteSession(sessionId) {
  if (!kvOffloadEnabled()) return { ok: false, reason: 'disabled' };
  const file = sessionFile(sessionId);
  const n = loadDoc(sessionId).chunks ? Object.keys(loadDoc(sessionId).chunks).length : 0;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true, removedChunks: n };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Sweep offload files older than maxAgeMs (mtime). Not called from any hook
 * today; the daily garbageCollect.js Phase C sweeps KV_DIR directly by mtime
 * (GC_SESSION_RETENTION_DAYS), which covers crashed/kill sessions too.
 * @param {number} maxAgeMs - 0 means "delete regardless of age"
 * @returns {number} number of files removed
 */
function sweepKv(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  let entries;
  try {
    entries = fs.readdirSync(KV_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(KV_DIR, name);
    try {
      const st = fs.statSync(full);
      if (maxAgeMs === 0 || st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {}
  }
  return removed;
}

module.exports = {
  KV_DIR,
  kvOffloadEnabled,
  putChunk,
  getChunk,
  listChunks,
  listInstructions,
  extractUserInstructions,
  setPinReleased,
  getPinReleased,
  deleteChunk,
  deleteSession,
  sweepKv,
};
