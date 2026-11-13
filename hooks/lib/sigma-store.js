// SKILL.state Σ store — per-session Σ file I/O (CJS — hooks/ scope).
//
// All file access for the per-session Σ state files: path resolution, locked
// read / write / read-modify-write, the cross-process history-absorb claim,
// live-session detection, housekeeping (sweep, compact_count), and the
// transcript-path derivation + persistence the hooks and the ACP host rely
// on. Content logic (transcript parsing, merge, filters, prompts, rendering)
// lives in the sibling modules.

const fs = require('fs');
const path = require('path');
const { withLock, atomicWrite } = require('./state.js');
const { SIGMA_DIR, SESSION_UUID_RE, CONFIG } = require('./config.js');

fs.mkdirSync(SIGMA_DIR, { recursive: true });

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
 * @param {number} [timeoutMs=2000] - lock-acquire deadline; the long-lived
 *   server path (index.js) passes 500 so a contended lock never blocks a
 *   request for 2s (P1-5). Short-lived hooks keep the 2000 default.
 * @returns {object|null} the Σ as written (null when mutate skipped)
 */
function mutateSigma(sessionId, mutate, timeoutMs = 2000) {
  const file = sigmaFile(sessionId);
  return withLock(file, () => {
    const current = loadSigma(sessionId);
    const next = mutate(current);
    if (next === null) return null;
    atomicWrite(file, JSON.stringify(next, null, 2));
    return next;
  }, timeoutMs);
}

// ─── Cross-process history-absorb claim (item 17) ─────────────────────────
// The PreCompact worker (a detached process) and the POST /sigma/refresh
// route (the server process) both absorb [hist_last_bytes, ...) for the same
// session. The server's in-process single-flight map (sigmaRefreshInFlight)
// cannot coordinate across processes, so both can start the same absorption.
// The merge itself is safe (mutateSigma is a cross-process file lock and the
// union is dedup-safe), so the overlap only wastes an LLM call — but a claim
// makes the second path skip instead of redo the work. The claim is a token +
// expiry; a fresh claim means the other path is in-flight. A crashed path
// leaves a stale claim that expires after the TTL (fail-open: the next
// refresh/compaction proceeds). The token makes the release safe: a late
// release from a crashed/slow path cannot clear a fresh claim another path
// set in the meantime.
const HIST_ABSORB_CLAIM_TTL_MS = CONFIG.HIST_ABSORB_CLAIM_TTL_MS; // > the worker's 120s LLM timeout + margin

/**
 * Claim the cross-process history absorption for a session (item 17).
 * Atomic (inside the mutateSigma file lock): a fresh claim by the other path
 * yields null (skip); otherwise sets the token + expiry and proceeds.
 * @param {string} sessionId
 * @param {number} [timeoutMs=2000] - lock-acquire deadline (see mutateSigma)
 * @returns {string|null} the claim token (pass it to releaseHistAbsorb), or null to skip
 */
function claimHistAbsorb(sessionId, timeoutMs = 2000) {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const written = mutateSigma(sessionId, (s) => {
    const now = Date.now();
    if ((Number(s.hist_inflight_until) || 0) > now) return null; // fresh claim by the other path
    return { ...s, hist_inflight_until: now + HIST_ABSORB_CLAIM_TTL_MS, hist_inflight_token: token };
  }, timeoutMs);
  return written ? token : null;
}

/**
 * Release the cross-process history absorption claim (item 17). Clears the
 * claim only when the token matches (a late release from a crashed/slow path
 * cannot clear a fresh claim set by another path).
 * @param {string} sessionId
 * @param {string} token - the token from claimHistAbsorb
 * @param {number} [timeoutMs=2000] - lock-acquire deadline (see mutateSigma)
 * @returns {void}
 */
function releaseHistAbsorb(sessionId, token, timeoutMs = 2000) {
  mutateSigma(sessionId, (s) =>
    s.hist_inflight_token === token ? { ...s, hist_inflight_until: 0, hist_inflight_token: null } : s,
    timeoutMs);
}

// ─── Live-session liveness (recent_work tool fallback) ───────────────────────
// The recent_work MCP tool resolves its session from QWEN_CODE_SESSION_ID
// (qwen-code sets it in the per-session MCP server's env — the exact caller
// identity). Only when that session's Σ state is absent or stale (a
// long-lived daemon/ACP MCP server reused across sessions) does it fall back
// to the freshest per-session Σ state file under a 15-min TTL — the hooks
// rewrite the running session's Σ every turn, so the fallback can never read
// another session's transcript while the env session still has fresh state.
const ACTIVE_SESSION_TTL_MS = CONFIG.ACTIVE_SESSION_TTL_MS;

/**
 * The freshest per-session Σ state file under the 15-min TTL (the liveness
 * signal the recent_work tool falls back to). The Stop/UserPromptSubmit hooks
 * rewrite the running session's Σ every turn with the real session id from
 * the hook payload, so the freshest mtime identifies the live session.
 * @returns {{session_id: string, ts: number, source: string}|null}
 */
function freshestSigmaSession() {
  const cutoff = Date.now() - ACTIVE_SESSION_TTL_MS;
  try {
    let best = null;
    for (const f of fs.readdirSync(SIGMA_DIR)) {
      if (!f.endsWith('.json')) continue;
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
 * Derive this session's transcript path from the fixed qwen layout
 * (~/.qwen/projects/<cwd /→->/chats/<session-id>.jsonl), scanning all
 * project dirs when the cwd-mapped one misses (session UUIDs are unique,
 * so the scan is unambiguous). Pure function of session_id — the Stop hook
 * was the only writer of Σ.transcript_path, but it does not fire on hosts
 * that don't run extension hooks (e.g. the ACP host), so this is the
 * self-sufficient counterpart.
 * @param {string} sessionId
 * @returns {string} absolute transcript path, or '' when not found
 */
function deriveTranscriptPath(sessionId) {
  if (!sessionId || !SESSION_UUID_RE.test(sessionId)) return '';
  const fileName = `${sessionId}.jsonl`;
  const projectsDir = path.join(HOME, '.qwen', 'projects');
  try {
    const direct = path.join(projectsDir, process.cwd().replace(/\//g, '-'), 'chats', fileName);
    if (fs.existsSync(direct)) return direct;
    for (const dir of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, dir, 'chats', fileName);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return '';
}

/**
 * Derive + persist Σ.transcript_path lazily (locked read-modify-write) and
 * return the path. The first engine contact of a session (kv-offload sigma
 * GET / eviction PUT) secures it for every consumer — recent_digest,
 * recent_work, the extraction workers — on hook-less hosts. Never overwrites
 * an existing value (lost-update guard inside the lock). Fail-open: '' on
 * any error or when the transcript cannot be derived.
 * @param {string} sessionId
 * @returns {string} the (persisted or pre-existing) transcript path, or ''
 */
function ensureTranscriptPath(sessionId) {
  try {
    if (!sessionId) return '';
    const existing = loadSigma(sessionId);
    if (typeof existing.transcript_path === 'string' && existing.transcript_path) {
      return existing.transcript_path;
    }
    const derived = deriveTranscriptPath(sessionId);
    if (!derived) return '';
    mutateSigma(sessionId, (s) => {
      if (typeof s.transcript_path === 'string' && s.transcript_path) return s; // already set
      s.transcript_path = derived;
      return s;
    });
    return derived;
  } catch {
    return '';
  }
}

/**
 * Recover the session's working directory from its transcript path for the
 * ghost-ref gate (review item 9). The qwen layout is
 * ~/.qwen/projects/<cwd with / replaced by ->/chats/<session>.jsonl, so the
 * project dir name is the cwd with / → -. The reverse (- → /) is ambiguous
 * when the cwd itself contains '-', so trust it only when the recovered path
 * is a real directory; otherwise fail open to '' (gate disabled — the prior
 * behavior) rather than risk resolving refs against a wrong base.
 * @param {string} transcriptPath
 * @returns {string} the session cwd, or '' when it cannot be recovered
 */
function cwdFromTranscriptPath(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return '';
  const parts = transcriptPath.split(path.sep);
  const idx = parts.lastIndexOf('projects');
  if (idx < 0 || idx + 1 >= parts.length) return '';
  const cwd = parts[idx + 1].replace(/-/g, path.sep);
  try {
    return fs.statSync(cwd).isDirectory() ? cwd : '';
  } catch {
    return '';
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
  const DEDUP_MS = CONFIG.COMPACT_BUMP_DEDUP_MS;
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

module.exports = {
  sigmaFile,
  loadSigma,
  saveSigma,
  mutateSigma,
  claimHistAbsorb,
  releaseHistAbsorb,
  freshestSigmaSession,
  deriveTranscriptPath,
  ensureTranscriptPath,
  cwdFromTranscriptPath,
  bumpCompactCount,
  sweepSigma,
};
