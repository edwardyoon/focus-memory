#!/usr/bin/env node
// Stop hook — SKILL.state per-Stop bookkeeping.
//
// Records three fields into Σ on every Stop (gated by
// FOCUSMEMORY_SKILLSTATE=on). No extraction, no model-facing output, no
// telemetry:
//   - last_input_tokens — the current context size (dashboard token display).
//     Optional: recorded only when the payload carries a usable token count.
//   - transcript_path — the recent_work MCP tool resolves its caller session
//     from QWEN_CODE_SESSION_ID alone and reads the transcript path from
//     here. The qwen-code Stop payload does NOT carry transcript_path (and
//     often no token count either), so this hook derives the path from the
//     standard layout ~/.qwen/projects/<cwd, / -> ->/chats/<sid>.jsonl,
//     falling back to a scan of all project dirs (session UUIDs are unique).
//   - last_turn_completion_signal — whether this turn ended with a
//     completion signal; the UserPromptSubmit hook flips anchor_completed
//     mechanically on the next user message when this flag is set.
//
// The LLM extraction triggers (state change / context growth / new user
// message), the server KV-state fetch, the offset management, and the
// detached worker spawn were removed 2026-10-24. The per-Stop triggers
// re-presented a lossy mid-work snapshot into Σ and fed the stale-anchor
// loop. Extraction now runs only at the PreCompact boundary (the shared
// detached worker) and on eviction PUTs (evictextract.js).
//
// Why Stop: it is the only existing qwen-code hook whose payload carries
// contextUsage (input_tokens) — the token signal needed for the bookkeeping
// above.
//
// Gated by FOCUSMEMORY_SKILLSTATE=on (off/unset → immediate no-op, zero
// behavior change). Fail-open: any error → silent exit 0; the session is
// unaffected. Emits no hook output (non-interfering: does not block or steer).

const fs = require('fs');
const os = require('os');
const path = require('path');
const ss = require('./lib/skillstate.js');

/**
 * Check file existence without throwing (hook must stay fail-open).
 * @param {string} p - absolute path
 * @returns {boolean} true when the file exists and is readable
 */
function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Resolve the session transcript JSONL path for the recent_work bookkeeping.
 * The qwen-code Stop payload does not carry transcript_path, so derive it
 * from the standard layout:
 *   ~/.qwen/projects/<cwd with / replaced by ->/chats/<sessionId>.jsonl
 * When the cwd-derived candidate misses (encoding differences), scan every
 * project dir — session UUIDs are unique across them.
 * @param {object} event - parsed Stop hook payload
 * @param {string} sessionId - the session id (UUID)
 * @returns {string} absolute transcript path, or '' when not found
 */
function resolveTranscriptPath(event, sessionId) {
  if (typeof event.transcript_path === 'string' && event.transcript_path) {
    return event.transcript_path;
  }
  const fileName = `${sessionId}.jsonl`;
  const projectsDir = path.join(os.homedir(), '.qwen', 'projects');
  const cwd = (typeof event.cwd === 'string' && event.cwd) || process.cwd();
  const direct = path.join(projectsDir, cwd.replace(/\//g, '-'), 'chats', fileName);
  if (fileExists(direct)) return direct;
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, dir, 'chats', fileName);
      if (fileExists(candidate)) return candidate;
    }
  } catch {
    // projects dir missing — no fallback possible
  }
  return '';
}

/**
 * Stop hook entry — record the three per-Stop bookkeeping fields into Σ.
 * No extraction, no model-facing output, no telemetry.
 * @returns {Promise<void>}
 */
async function main() {
  if (!ss.skillStateEnabled()) return; // gate off → zero behavior change

  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = event.session_id;
  if (!sessionId) return;

  // input_tokens is OPTIONAL: the qwen-code Stop payload spreads
  // ...contextUsage, which is undefined when the token count is unavailable,
  // so the field is frequently absent. Record it when usable; never skip the
  // whole bookkeeping because of it (old hard guard silently disabled the
  // hook — observed 2026-10-29: no transcript_path in any session Σ).
  const inputTokens = Number(event.input_tokens ?? event.contextUsage?.input_tokens);

  // Per-Stop bookkeeping as ONE locked read-modify-write: this hook and the
  // other Stop hooks (ghost-gate, turn-guard) run concurrently on the same
  // event, and the old load→modify→save sequence let same-second saves
  // clobber each other (lost update — observed 2026-09-28 disabling the
  // ghost-gate loop guard).
  ss.mutateSigma(sessionId, (sigma) => {
    // Current context size (dashboard token display).
    if (Number.isFinite(inputTokens) && inputTokens > 0) {
      sigma.last_input_tokens = inputTokens;
    }

    // Transcript path bookkeeping (recent_work MCP tool): the tool resolves
    // its caller session from QWEN_CODE_SESSION_ID alone and reads the
    // transcript path from here. Derive it when the payload omits it.
    const transcriptPath = resolveTranscriptPath(event, sessionId);
    if (transcriptPath) {
      sigma.transcript_path = transcriptPath;
    }

    // Completion-signal flag (2026-10-15 stale-anchor incident): record
    // whether THIS turn ended with a completion signal in the final
    // assistant message; the UserPromptSubmit hook flips anchor_completed
    // mechanically on the next user message when this flag is set. Every
    // Stop rewrites the flag (false clears a stale one), so no separate
    // consumption is needed here.
    sigma.last_turn_completion_signal = ss.completionSignal(String(event.last_assistant_message || ''));

    return sigma;
  });
}

main().catch(() => {}); // fail-open — a hook error must never break the session
