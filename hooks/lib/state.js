// Shared state + telemetry helpers for FocusMemory hooks (CJS — hooks/ scope).
//
// The per-session state file (~/.qwen/tmp/tool-calls/<sid>.json) is read-modify-
// written by several hook processes that run concurrently:
//   - reset-memory-flag.js  (every UserPromptSubmit, milliseconds)
//   - the HTTP recall hook  (same UserPromptSubmit, seconds later, via index.js)
//   - log-tool-call.js      (PreToolUse, possibly in parallel with a lingering
//                            recall write from a previous turn)
// updateState() serializes writers with an exclusive lockfile (O_EXCL) so a
// concurrent writer can never drop an update (a lost epoch increment would
// let the previous turn's satisfaction leak into the new turn — a silent
// gate bypass). atomicWrite() still guarantees readers never see a torn
// file.
//
// Turn attribution: reset-memory-flag.js increments `turnEpoch` on every
// prompt and clears the satisfaction stamp; the recall/search_memory writers
// stamp `memoryCalledEpoch = current turnEpoch`. The gate only passes when
// `memoryCalledEpoch === turnEpoch`, so a stale stamp from an earlier turn
// (e.g. after a failed recall on the new turn) can never satisfy the gate.

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.qwen', 'tmp', 'tool-calls');
const TELEMETRY_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.qwen', 'tmp', 'focus-memory');
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(TELEMETRY_DIR, { recursive: true });

/**
 * Absolute path of a session's state file.
 * @param {string} sessionId
 * @returns {string}
 */
function stateFile(sessionId) {
  return path.join(STATE_DIR, `${sessionId}.json`);
}

/**
 * Read a session's state; missing or corrupt file yields {}.
 * @param {string} sessionId
 * @returns {object}
 */
function loadState(sessionId) {
  try {
    if (fs.existsSync(stateFile(sessionId))) {
      return JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8'));
    }
  } catch {}
  return {};
}

/**
 * Atomic write: write to a temp file in the same directory, then rename
 * (rename is atomic on POSIX). Readers never observe a torn state file.
 * @param {string} file
 * @param {string} content
 */
function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// P1-5: yield the thread (Atomics.wait) instead of CPU-spinning — a spin-wait
// on the lock deadline burns a core for the whole wait; the MCP server is a
// long-lived process that must not hog a core while polling the lockfile.
const _SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
/**
 * Synchronous sleep — yields the thread via Atomics.wait (no CPU spin).
 * May return early if woken (we never signal, so this is rare); callers
 * re-check their deadline in a loop, so an early return is safe.
 * @param {number} ms
 */
function sleepMs(ms) {
  Atomics.wait(_SLEEP_BUF, 0, 0, Math.max(1, ms));
}

/**
 * Run fn() while holding an exclusive lock on `file` (O_EXCL lockfile).
 * A lock whose holder crashed is removed once older than staleMs. If the
 * lock cannot be acquired within timeoutMs, fn() runs without it (best
 * effort) — a hook must never hang the session.
 * @param {string} file
 * @param {() => any} fn
 * @param {number} [timeoutMs=2000]
 * @param {number} [staleMs=5000]
 * @returns {any} fn()'s return value
 */
function withLock(file, fn, timeoutMs = 2000, staleMs = 5000) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch {
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {}
      sleepMs(5);
    }
  }
  if (acquired) {
    try {
      return fn();
    } finally {
      try { fs.unlinkSync(lock); } catch {}
    }
  }
  return fn();
}

/**
 * Lock-protected read-modify-write of the session state file.
 * @param {string} sessionId
 * @param {(state: object) => object|null} mutate - returns the next state, or null to skip the write
 * @returns {object|null} the state as written (null when mutate skipped)
 */
function updateState(sessionId, mutate) {
  const file = stateFile(sessionId);
  return withLock(file, () => {
    const state = loadState(sessionId);
    const next = mutate(state);
    if (next === null) return null;
    atomicWrite(file, JSON.stringify(next));
    return next;
  });
}

/**
 * Keep a JSONL file bounded: once it exceeds maxBytes, truncate to the last
 * keepLines entries. statSync-per-append is cheap; truncation itself is rare.
 * @param {string} file
 * @param {number} [maxBytes=512*1024]
 * @param {number} [keepLines=1000]
 */
function rotateJsonl(file, maxBytes = 512 * 1024, keepLines = 1000) {
  try {
    if (fs.statSync(file).size > maxBytes) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      fs.writeFileSync(file, lines.slice(-keepLines).join('\n'));
    }
  } catch {}
}

/**
 * Append a telemetry entry to the shared gate-telemetry.jsonl (rotated).
 * @param {object} entry
 */
function appendTelemetry(entry) {
  const file = path.join(TELEMETRY_DIR, 'gate-telemetry.jsonl');
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    rotateJsonl(file);
  } catch {}
}

/**
 * Delete state-dir files older than maxAgeMs (mtime), optionally restricted
 * to names starting with `prefix`. Best-effort; returns removed count.
 * @param {number} maxAgeMs - 0 means "delete regardless of age" (within prefix)
 * @param {string} [prefix]
 * @returns {number}
 */
function sweepStale(maxAgeMs, prefix = null) {
  const cutoff = Date.now() - maxAgeMs;
  let entries;
  try {
    entries = fs.readdirSync(STATE_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (prefix && !name.startsWith(prefix)) continue;
    if (!/\.(json|jsonl|tmp|lock)$/.test(name)) continue;
    const full = path.join(STATE_DIR, name);
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

module.exports = {
  STATE_DIR,
  TELEMETRY_DIR,
  stateFile,
  loadState,
  atomicWrite,
  withLock,
  updateState,
  rotateJsonl,
  appendTelemetry,
  sweepStale,
};
