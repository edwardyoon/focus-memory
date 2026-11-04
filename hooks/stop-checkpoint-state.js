#!/usr/bin/env node
// Stop hook — SKILL.state per-Stop bookkeeping.
//
// Records into Σ on every Stop (gated by FOCUSMEMORY_SKILLSTATE=on):
//   - last_input_tokens — the current context size (dashboard token display).
//     Optional: recorded only when the payload carries a usable token count.
//   - context_usage / context_limit — the window ratio (0..1) and size from
//     the contextUsage spread.
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
// Why Stop: it is the only existing qwen-code hook whose payload carries
// contextUsage (input_tokens / context_usage) — the token signal needed
// for the bookkeeping.
//
// Σ generation is NOT done here (2026-11-04 Phase 2): the periodic delta
// extraction and the 70% boundary arm/notice were removed — Σ is extracted
// only at native compaction (the PreCompact hook). This hook is pure
// bookkeeping and emits no stdout.
//
// Gated by FOCUSMEMORY_SKILLSTATE=on (off/unset → immediate no-op, zero
// behavior change). Fail-open: any error → silent exit 0; the session is
// unaffected.

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
 * Stop hook entry — bookkeeping only.
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

  // The Stop payload spreads ...contextUsage, which is undefined when the
  // token count is unavailable — every field is optional.
  const inputTokens = Number(event.input_tokens ?? event.contextUsage?.input_tokens);
  const contextUsage = Number(event.context_usage ?? event.contextUsage?.context_usage);
  const contextLimit = Number(event.context_limit ?? event.contextUsage?.context_limit);

  // Resolve before the mutation lock: the path is recorded inside the same
  // locked write below.
  const transcriptPath = resolveTranscriptPath(event, sessionId);

  // Bookkeeping as ONE locked read-modify-write: this hook and the other
  // Stop hook (ghost-gate) run concurrently on the same event, and the old
  // load→modify→save sequence let same-second saves clobber each other
  // (lost update — observed 2026-09-28 disabling the ghost-gate loop guard).
  ss.mutateSigma(sessionId, (sigma) => {
    // Current context size (dashboard token display).
    if (Number.isFinite(inputTokens) && inputTokens > 0) {
      sigma.last_input_tokens = inputTokens;
    }

    // Window ratio / size.
    if (Number.isFinite(contextUsage) && contextUsage > 0) {
      sigma.context_usage = contextUsage;
    }
    if (Number.isFinite(contextLimit) && contextLimit > 0) {
      sigma.context_limit = contextLimit;
    }

    // Transcript path bookkeeping (recent_work MCP tool): the tool resolves
    // its caller session from QWEN_CODE_SESSION_ID alone and reads the
    // transcript path from here.
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
