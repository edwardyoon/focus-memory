#!/usr/bin/env node
// Stop hook — SKILL.state per-Stop bookkeeping.
//
// Records three fields into Σ on every Stop (gated by
// FOCUSMEMORY_SKILLSTATE=on). No extraction, no model-facing output, no
// telemetry:
//   - last_input_tokens — the current context size (dashboard token display).
//   - transcript_path — the recent_work MCP tool resolves its caller session
//     from QWEN_CODE_SESSION_ID alone and reads the transcript path from
//     here; the hook is the only component that sees event.transcript_path
//     reliably.
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
const ss = require('./lib/skillstate.js');

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
  const inputTokens = Number(event.input_tokens);
  if (!sessionId || !Number.isFinite(inputTokens) || inputTokens <= 0) return;

  // Per-Stop bookkeeping as ONE locked read-modify-write: this hook and the
  // other Stop hooks (ghost-gate, turn-guard) run concurrently on the same
  // event, and the old load→modify→save sequence let same-second saves
  // clobber each other (lost update — observed 2026-09-28 disabling the
  // ghost-gate loop guard).
  ss.mutateSigma(sessionId, (sigma) => {
    // Current context size (dashboard token display).
    sigma.last_input_tokens = inputTokens;

    // Transcript path bookkeeping (recent_work MCP tool): the tool resolves
    // its caller session from QWEN_CODE_SESSION_ID alone and reads the
    // transcript path from here — the hook is the only component that sees
    // event.transcript_path reliably.
    if (typeof event.transcript_path === 'string' && event.transcript_path) {
      sigma.transcript_path = event.transcript_path;
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
