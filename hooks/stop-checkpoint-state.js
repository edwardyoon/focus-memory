#!/usr/bin/env node
// Stop hook — SKILL.state per-Stop bookkeeping + boundary detection
// (2026-11-03 compressFast boundary).
//
// Records into Σ on every Stop (gated by FOCUSMEMORY_SKILLSTATE=on):
//   - last_input_tokens — the current context size (dashboard token display).
//     Optional: recorded only when the payload carries a usable token count.
//   - context_usage / context_limit — the window ratio (0..1) and size from
//     the contextUsage spread; the 70% crossing signal.
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
// Boundary detection (2026-11-03):
//   - Periodic delta extraction: input_tokens grew ≥ FOCUSMEMORY_EXTRACT_DELTA_TOKENS
//     (default 20000) since the last spawn → spawn the shared detached
//     extraction worker (precompact-extract-state.js, --llm summary →
//     gemma-4). Keeps Σ fresh mid-session so the boundary compensation has
//     a fresh base. last_extraction_tokens is the token baseline (spawn-time;
//     a failed worker re-arms naturally at the next delta).
//   - 70% crossing: context_usage ≥ FOCUSMEMORY_BOUNDARY_PCT (default 0.70)
//     && !boundary_armed → arm the boundary (boundary_armed, sticky) + spawn
//     the final delta extraction (fresh Σ before the strip) + emit a
//     non-blocking systemMessage: the user can run /compress-fast now, and
//     the next prompt gets the synchronous boundary compensation (the
//     UserPromptSubmit hook consumes boundary_armed exactly once).
//
// compressFast fires NO hooks, so detection lives here (before the strip)
// and compensation lives in UserPromptSubmit (after the strip) — the
// flag-based handoff needs no token-drop observation.
//
// Why Stop: it is the only existing qwen-code hook whose payload carries
// contextUsage (input_tokens / context_usage) — the token signal needed
// for both the bookkeeping and the crossing check.
//
// Gated by FOCUSMEMORY_SKILLSTATE=on (off/unset → immediate no-op, zero
// behavior change). Fail-open: any error → silent exit 0; the session is
// unaffected. The only output is the one-shot boundary systemMessage.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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
 * Spawn the shared detached Σ extraction worker (precompact-extract-state.js
 * in --worker mode). Event-agnostic: it reads the transcript delta from Σ's
 * byte offset, calls the LLM, and merges the patch — the trigger is
 * telemetry-only. --llm summary → gemma-4 (the periodic/boundary extraction
 * is never model-facing, so the lightweight model is enough; the boundary
 * COMPENSATION — the model-facing part — uses the main LLM synchronously in
 * the UserPromptSubmit hook).
 * @param {string} sessionId
 * @param {string} transcriptPath - '' when unresolved (worker then reads 0 bytes and no-ops)
 * @param {string} trigger - 'delta' | 'boundary' (telemetry)
 */
function spawnExtractionWorker(sessionId, transcriptPath, trigger) {
  try {
    const child = spawn(process.execPath, [
      path.join(__dirname, 'precompact-extract-state.js'),
      '--worker',
      JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, trigger }),
      '--llm', 'summary',
    ], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch (err) {
    console.error(`[skillstate] worker spawn failed: ${err.message}`);
  }
}

/**
 * Stop hook entry — bookkeeping + boundary detection.
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
  // token count is unavailable — every field is optional (a missing
  // input_tokens disables the delta check, a missing context_usage the
  // crossing check; bookkeeping always runs).
  const inputTokens = Number(event.input_tokens ?? event.contextUsage?.input_tokens);
  const contextUsage = Number(event.context_usage ?? event.contextUsage?.context_usage);
  const contextLimit = Number(event.context_limit ?? event.contextUsage?.context_limit);

  const deltaTokens = Math.max(1000, parseInt(ss.env('FOCUSMEMORY_EXTRACT_DELTA_TOKENS', '20000'), 10) || 20000);
  const boundaryPct = (() => {
    const v = parseFloat(ss.env('FOCUSMEMORY_BOUNDARY_PCT', '0.70'));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.70;
  })();

  // Resolve BEFORE the mutation lock: the worker spawn (outside the lock)
  // needs the path.
  const transcriptPath = resolveTranscriptPath(event, sessionId);

  let spawned = false;
  let boundaryNotice = '';

  // Bookkeeping + detection as ONE locked read-modify-write: this hook and
  // the other Stop hook (ghost-gate) run concurrently on the same event,
  // and the old load→modify→save sequence let same-second saves clobber
  // each other (lost update — observed 2026-09-28 disabling the ghost-gate
  // loop guard).
  ss.mutateSigma(sessionId, (sigma) => {
    // Current context size (dashboard token display).
    if (Number.isFinite(inputTokens) && inputTokens > 0) {
      sigma.last_input_tokens = inputTokens;
    }

    // Window ratio / size (2026-11-03 boundary detection).
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

    // Boundary detection (2026-11-03). The crossing takes precedence over
    // the plain delta check — at most one worker per Stop, and the crossing
    // IS the final delta extraction.
    const tokens = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : null;
    const deltaDue = tokens !== null &&
      tokens - (Number(sigma.last_extraction_tokens) || 0) >= deltaTokens;
    const crossing = Number.isFinite(contextUsage) && contextUsage >= boundaryPct &&
      sigma.boundary_armed !== true;

    if (crossing) {
      // Sticky: consumed exactly once by the UserPromptSubmit hook (the
      // boundary compensation). No re-arm within the session — one boundary,
      // one compensation (design §5.1).
      sigma.boundary_armed = true;
      if (tokens !== null) {
        sigma.boundary_armed_tokens = tokens;
        sigma.last_extraction_tokens = tokens;
      }
      spawned = true;
      boundaryNotice = `경계 준비 — 컨텍스트 ${Math.round(contextUsage * 100)}% (≥${Math.round(boundaryPct * 100)}%). /compress-fast 가능 (기계적 strip, 수 초). 다음 프롬프트에 경계보상이 자동 주입됩니다.`;
    } else if (deltaDue) {
      if (tokens !== null) {
        sigma.last_extraction_tokens = tokens;
      }
      spawned = true;
    }

    return sigma;
  });

  if (spawned) {
    spawnExtractionWorker(sessionId, transcriptPath, boundaryNotice ? 'boundary' : 'delta');
  }
  if (boundaryNotice) {
    // Non-blocking user notice (NOT decision:block — the turn ends normally;
    // the message just tells the user the boundary is ready).
    process.stdout.write(JSON.stringify({ systemMessage: boundaryNotice }));
  }
}

main().catch(() => {}); // fail-open — a hook error must never break the session
