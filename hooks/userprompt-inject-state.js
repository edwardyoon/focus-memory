#!/usr/bin/env node
// UserPromptSubmit hook — SKILL.state mechanical anchor lifecycle maintenance
// + one-shot boundary compensation.
//
// Four mechanical features run on every user prompt (gated by
// FOCUSMEMORY_SKILLSTATE=on); they keep the anchor lifecycle current so the
// SessionStart(compact) re-injection and the Stop gate's anchor window stay
// correct:
//   1. foreign-session scrub — Σ files written before the merge-time gate (or
//      via a leak it missed) may carry another session's state-file citation;
//      scrub at presentation time and persist the scrub when it removed
//      anything, so the foreign anchor stops re-latching.
//   2. completion-signal flip — when the previous turn ended with a
//      completion signal (the Stop hook's last_turn_completion_signal), flip
//      anchor_completed mechanically (no LLM) and arm the one-shot reset.
//   3. B4 pin release — rule-based, no LLM: release the kv-offload pin when
//      the on-disk Σ already marks the original task revoked or complete.
//   4. current-view reset — on the first user message after a completion,
//      wipe the current-view keys (confirmed/hypothesis/next/legacy) so
//      the finished task's view does not re-latch the model.
//   5. boundary compensation (2026-11-03 compressFast boundary) — one-shot,
//      the ONLY LLM call this hook makes: when the Stop hook armed the
//      boundary (context ≥ FOCUSMEMORY_BOUNDARY_PCT, default 70%) and this is
//      the first prompt after (the /compress-fast strip fires NO hooks),
//      call the main LLM (qwen27b, 30s cap) to reconstruct the state the
//      strip removed and inject it once as additionalContext — the
//      <qwen:user-prompt-submit-context> block survives the strip. In steady
//      state (boundary not armed) feature 5 is a flag check — milliseconds.
//
// The per-turn Σ injection (anchor/ctx block, offloaded instruction ledger,
// verbatim current-user-instruction block, language directive) was removed
// 2026-10-24: it re-presented a one-turn-stale anchor on every prompt, and
// the model paid a constant cost reconciling that noise with the live work.
// Mid-turn recall now rides the server's DA scaffold Σ anchor (focus-llama
// GET /v1/kv-offload/session/sigma), which fires on every request while
// history is offloaded; boundary re-injection is the SessionStart(compact)
// hook.
//
// Gated by FOCUSMEMORY_SKILLSTATE=on (off/unset → immediate no-op, zero
// behavior change). Fail-open: any error → silent exit 0, the turn proceeds.

const fs = require('fs');
const ss = require('./lib/skillstate.js');
const kv = require('./lib/kvoffload.js');

// Boundary compensation sizing (2026-11-03): the call runs SYNCHRONOUSLY
// inside the UserPromptSubmit hook timeout (qwen-extension.json: 40s), so
// the caps target a fast qwen27b round trip on the 5090 node — not the
// detached worker's 120s envelope.
const BOUNDARY_TAIL_CHARS = Math.max(2000, parseInt(ss.env('FOCUSMEMORY_BOUNDARY_TAIL_CHARS', '15000'), 10) || 15000);
const BOUNDARY_TIMEOUT_MS = 30000;

/**
 * UserPromptSubmit hook entry — mechanical anchor lifecycle maintenance +
 * one-shot boundary compensation (feature 5, the only LLM call).
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

  let sigma = ss.loadSigma(sessionId);

  // Foreign-session scrub at presentation time (2026-10-17): Σ files written
  // before the merge-time gate (or via a leak it missed) may carry another
  // session's state-file citation. Scrub the loaded Σ in memory and persist
  // the scrub when it removed anything, so the foreign anchor stops
  // re-latching through the SessionStart re-injection and the server's DA
  // scaffold anchor.
  if (sigma) {
    const scrubbed = ss.scrubSigmaForeignRefs(sigma, sessionId);
    if (scrubbed.length) {
      try {
        ss.mutateSigma(sessionId, (cur) => {
          const removed = ss.scrubSigmaForeignRefs(cur, sessionId);
          return removed.length ? cur : null; // already clean — skip the write
        });
      } catch { /* fail-open — the in-memory scrub still covers this turn */ }
      ss.appendTelemetry({
        ts: Date.now(),
        session_id: sessionId,
        hook: 'userprompt-inject-state',
        event: 'foreign_refs_scrubbed',
        removed: scrubbed,
      });
    }
  }

  // Completion-signal-gated task-switch flip (2026-10-15 stale-anchor
  // incident): the Stop hook sets last_turn_completion_signal when the
  // previous turn ended with a completion signal. The LLM anchor rule is
  // one turn late — the first turn AFTER a completion runs with the stale
  // anchor (the incident: the model resumed a committed/pushed task). When
  // the flag is set and the anchor is not already done, flip
  // anchor_completed mechanically (no LLM) and arm the one-shot reset:
  // the B4 block below releases the pin, the reset block below wipes the
  // finished task's current view, and the evict-extract anchor-done gate
  // keeps old evicted segments from re-populating next.
  if (sigma && sigma.last_turn_completion_signal === true &&
      sigma.anchor_completed !== true && sigma.anchor_revoked !== true) {
    try {
      let flipKind = null;
      const flipped = ss.mutateSigma(sessionId, (cur) => {
        if (!cur || cur.last_turn_completion_signal !== true) return null; // re-check inside the lock
        cur.last_turn_completion_signal = false; // consume — one-shot
        if (cur.anchor_completed === true || cur.anchor_revoked === true) {
          flipKind = 'consumed_already_done';
          return cur;
        }
        cur.anchor_completed = true;
        cur.anchor_reset_pending = true; // the reset block below wipes the current view
        // Baseline for the anchor-done gate (2026-10-20 stale-anchor fix):
        // the reset block below wipes cur.next, so capture the completed
        // task's next HERE — the gate compares incoming next lists against
        // it to tell a stale re-derivation (strip) from a new task (release).
        cur.anchor_done_next = Array.isArray(cur.next) ? cur.next.slice() : [];
        flipKind = 'flipped';
        return cur;
      });
      if (flipped) {
        sigma = flipped;
        ss.appendTelemetry({
          ts: Date.now(),
          session_id: sessionId,
          hook: 'userprompt-inject-state',
          event: flipKind === 'flipped' ? 'anchor_flipped_completion_signal' : 'completion_signal_consumed',
        });
      }
    } catch {
      // fail-open — the turn proceeds even if the flip write throws
    }
  }

  // B4 pin release — rule-based, no LLM (2026-10-03): the existing release
  // path only fires at extraction, which is one turn late — the FIRST turn
  // after a superseding user message ran with the stale pin. Release here,
  // at the start of the turn, whenever the on-disk Σ already marks the
  // original task revoked or complete. Idempotent/sticky in kv-offload; the
  // engine reads pin_released at its next eviction plan.
  if (sigma && (sigma.anchor_revoked === true || sigma.anchor_completed === true)) {
    try {
      if (!kv.getPinReleased(sessionId)) {
        const res = kv.setPinReleased(sessionId);
        ss.appendTelemetry({
          ts: Date.now(),
          session_id: sessionId,
          hook: 'userprompt-inject-state',
          event: res.ok ? 'pin_released' : 'pin_release_write_failed',
          ...(res.ok ? {} : { reason: res.reason }),
        });
      }
    } catch {
      // fail-open — the turn proceeds even if the release write throws
    }
  }

  // Σ current-view reset on post-completion context switch (2026-10-03):
  // the extraction worker sets anchor_reset_pending when a sticky anchor
  // flag flips to true (task completed / revoked). On THIS user message —
  // the first one after the switch — wipe the current-view keys, which
  // still describe the finished task; re-presented as the anchor they would
  // re-latch the model onto the old work (stale-anchor failure mode). The
  // flag is consumed in the same locked write, so the reset fires exactly
  // once: the new task's re-populated keys (merge rule: replace) survive
  // all later turns. Session bookkeeping (token counts) and the sticky
  // anchor flags are kept: the pin-release logic above and the engine's
  // eviction plan read them.
  if (sigma && sigma.anchor_reset_pending === true) {
    try {
      ss.mutateSigma(sessionId, (cur) => {
        if (!cur || cur.anchor_reset_pending !== true) return null; // re-check inside the lock
        cur.anchor_reset_pending = false; // consume — exactly one reset per completion
        // Three-section schema (2026-10-09): all three are the current view.
        delete cur.confirmed;
        delete cur.hypothesis;
        delete cur.next;
        // Model-owned verbatim notes are the current task's too — wipe them
        // with the view so the next task starts clean.
        delete cur.notes;
        // Legacy flat keys (pre-2026-10-09 Σ files).
        delete cur.task_summary;
        delete cur.current_step;
        delete cur.pending_checks;
        return cur;
      });
    } catch {
      // fail-open
    }
  }

  // Boundary compensation (2026-11-03 compressFast boundary) — one-shot, the
  // only LLM call in this hook. The Stop hook armed the boundary at the
  // crossing; the user ran /compress-fast (the strip fires NO hooks); THIS
  // prompt is the first one after. Reconstruct the stripped tool-result
  // state from the current Σ (fresh — the crossing spawned a final delta
  // extraction) + the transcript tail (consistency check against the
  // surviving text) via the main LLM, and inject it once as additionalContext.
  // Runs LAST so it sees the post-maintenance Σ (the flip/reset above may
  // have rewritten the view keys).
  if (sigma && sigma.boundary_armed === true && sigma.boundary_consumed !== true) {
    try {
      const fresh = ss.loadSigma(sessionId) || sigma;
      const tail = fresh.transcript_path
        ? ss.extractTranscriptTail(fresh.transcript_path, BOUNDARY_TAIL_CHARS, { maxChars: BOUNDARY_TAIL_CHARS })
        : '';
      const out = await ss.callMainLLM(ss.buildBoundaryPrompt(fresh, tail, sessionId), BOUNDARY_TIMEOUT_MS);
      if (out && out.trim()) {
        ss.emitHookOutput({
          hookEventName: 'UserPromptSubmit',
          additionalContext: out.trim(),
        });
        ss.mutateSigma(sessionId, (cur) => {
          cur.boundary_consumed = true; // one-shot — no re-injection
          return cur;
        });
        ss.appendTelemetry({
          ts: Date.now(),
          session_id: sessionId,
          hook: 'userprompt-inject-state',
          event: 'boundary_compensated',
        });
      } else {
        // fail-open: no injection this prompt. Retry ONCE on the next prompt
        // (design §5.2); after 2 failed attempts mark consumed so a down
        // qwen27b never blocks every prompt for 30s.
        const attempts = (Number(fresh.boundary_retry) || 0) + 1;
        ss.mutateSigma(sessionId, (cur) => {
          cur.boundary_retry = attempts;
          if (attempts >= 2) cur.boundary_consumed = true;
          return cur;
        });
        ss.appendTelemetry({
          ts: Date.now(),
          session_id: sessionId,
          hook: 'userprompt-inject-state',
          event: 'boundary_compensation_failed',
          attempts,
        });
      }
    } catch {
      // fail-open — the turn proceeds without compensation
    }
  }
}

main().catch(() => {}); // fail-open — a hook error must never break the turn
