#!/usr/bin/env node
// UserPromptSubmit hook — SKILL.state per-turn state anchor injection.
//
// Injection (2026-10-17): unconditional per-turn. While Σ has content, the
// anchor is re-presented on every user prompt: a KV break can drop the
// previously injected copy at any turn, and the 2026-10-09 gate ("inject
// only when the content hash changed or evictions > 0") left exactly those
// unchanged-Σ turns anchor-less. The per-turn cost is a few hundred tokens;
// the stale-anchor failure mode is not worth saving them. The content hash
// (sigma.last_inject_hash) is still computed and reported in telemetry as
// the dominant reason (sigma_changed | evictions | per_turn).
//
// Why: lost-in-the-middle dilution in long live sessions. The model re-
// derives "what am I doing" from an ever-growing transcript; an explicit
// state reminder keeps the current task/step/pending checks salient
// without re-injecting the full Σ (that would cost real tokens every turn).
//
// 2026-10-02: the anchor is rendered from the PREVIOUS turn's Σ (one turn
// behind by construction). An imperative "task:" label made the model
// resume a completed/superseded task instead of answering the user's new
// message (mid-investigation jump back to a finished re-apply task). The
// anchor is now framed as a record, not a directive (renderAnchor
// record:true + the preamble below).
//
// If the previous turn's extraction worker is still running, the anchor is
// one turn stale — harmless: the live tail of the transcript contains
// everything done since, and the next turn's anchor is fresh.
//
// Pinning (2026-10-09, focus-llama kv_offload_evict): both blocks ride the
// current (LAST) user message, which the engine never evicts — the latest
// Σ block is therefore sticky-pinned in the KV by construction, while
// earlier injections live in middle user messages that are normal eviction
// candidates (unpinned, offloadable). The system prompt is untouched, so
// --cache-reuse prefix caching is preserved.
//
// Gated by FOCUSMEMORY_SKILLSTATE=on (off/unset → immediate no-op, zero
// behavior change). Fail-open: any error → silent exit 0, the turn proceeds
// without the injection.

const fs = require('fs');
const crypto = require('crypto');
const ss = require('./lib/skillstate.js');
const kv = require('./lib/kvoffload.js');

// Keys that constitute the model-facing Σ content — the hash over these
// decides re-injection. Deliberately EXCLUDES hook-internal bookkeeping
// (kv_state, last_input_tokens, compact_count, byte offsets, turn-guard
// state, last_inject_hash): the server-value `ctx:` line and the bookkeeping
// change every turn and must not force a re-injection of an unchanged Σ.
const CONTENT_KEYS = [
  'confirmed', 'hypothesis', 'next',
  'anchor_revoked', 'anchor_completed', 'recall_pointers',
  // Legacy flat keys (pre-2026-10-09 Σ files)
  'task_summary', 'current_step', 'pending_checks', 'files_touched', 'tests_status',
];

/**
 * Stable hash of the model-facing Σ content (the `ctx:` line and all
 * bookkeeping excluded).
 * @param {object} sigma
 * @returns {string} 16-hex-char sha256 prefix
 */
function sigmaContentHash(sigma) {
  const content = {};
  for (const k of CONTENT_KEYS) {
    if (sigma[k] !== undefined) content[k] = sigma[k];
  }
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

/**
 * True when the Σ carries any non-empty model-facing content.
 * @param {object} sigma
 * @returns {boolean}
 */
function hasContent(sigma) {
  if (!sigma) return false;
  return CONTENT_KEYS.some((k) => {
    const v = sigma[k];
    if (v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.trim().length > 0;
    return true; // e.g. anchor flags (booleans)
  });
}

/**
 * One-line server KV snapshot for the injected block (the `ctx:` line),
 * built from the Stop hook's per-turn kv_state record. Excluded from the
 * Σ content hash (it is server-value bookkeeping, not Σ content).
 * @param {object} sigma
 * @returns {string} '' when no kv_state snapshot is recorded
 */
function ctxLine(sigma) {
  const s = sigma && sigma.kv_state;
  if (!s || typeof s !== 'object') return '';
  const n = (k) => (Number.isFinite(Number(s[k])) ? String(s[k]) : '?');
  return `ctx: logical=${n('logical')} resident=${n('resident')} offloaded=${n('offloaded')} evictions=${n('evictions')} buffer=${n('buffer')}`;
}

/**
 * UserPromptSubmit hook entry — injects up to three independent blocks:
 *   1. the Σ state anchor (+ the `ctx:` server KV line);
 *   2. the evicted user-instruction ledger (kv-offload);
 *   3. the verbatim current user instruction (anti-stale-anchor).
 * All blocks are gated on Σ having content and ride the current (last) user
 * message, so kv_offload_evict's last-user protection keeps them in the KV.
 * @returns {void}
 */
function main() {
  const ssOn = ss.skillStateEnabled();
  if (!ssOn) return; // gate off → zero behavior change

  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = event.session_id;
  if (!sessionId) return;

  const parts = [];
  let injectedSigma = false;
  let sigmaHash = null;

  if (ssOn) {
    let sigma = ss.loadSigma(sessionId);

    // Foreign-session scrub at presentation time (2026-10-17): Σ files written
    // before the merge-time gate (or via a leak it missed) may carry another
    // session's state-file citation. Scrub the loaded Σ in memory — the anchor
    // below renders from it — and persist the scrub when it removed anything:
    // the content-hash re-baseline re-injects the clean version next turn and
    // the foreign anchor stops re-latching.
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
    // path only fires at Stop/PreCompact extraction, which is one turn late —
    // the FIRST turn after a superseding user message ran with the stale pin.
    // Release here, at the start of the turn, whenever the on-disk Σ already
    // marks the original task revoked or complete. Idempotent/sticky in
    // kv-offload; the engine reads pin_released at its next eviction plan.
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
    // still describe the finished task; re-injected as the anchor they would
    // re-latch the model onto the old work (stale-anchor failure mode). The
    // flag is consumed in the same locked write, so the reset fires exactly
    // once: the new task's re-populated keys (merge rule: replace) survive
    // all later turns. Session bookkeeping (token counts, kv_state) and the
    // sticky anchor flags are kept: the pin-release logic above and the
    // engine's eviction plan read them.
    if (sigma && sigma.anchor_reset_pending === true) {
      try {
        const reset = ss.mutateSigma(sessionId, (cur) => {
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
        if (reset) sigma = reset; // render the anchor below from the post-reset Σ
      } catch {
        // fail-open
      }
    }

    // Injection (2026-10-17): unconditional per-turn anchor injection. While
    // Σ has content, the record is re-presented on every user prompt, so a
    // KV hole / eviction can never strand the model without state — the
    // 2026-10-09 "changed-or-evictions" gate left unchanged-Σ turns
    // anchor-less, which is exactly when a KV break loses the thread.
    if (hasContent(sigma)) {
      const tokens = Number(sigma.last_input_tokens) || 0;
      const hash = sigmaContentHash(sigma);
      const evictions = Number(sigma.kv_state && sigma.kv_state.evictions) || 0;
      const changed = sigma.last_inject_hash !== hash;
      let instrCount = 0;
      // record: true — the anchor is one turn behind by construction; an
      // imperative "task:" label made the model resume a completed/superseded
      // task instead of answering the user's new message (2026-10-02 incident).
      const anchor = ss.renderAnchor(sigma, { record: true });
      if (anchor) {
        let block =
          `Session state anchor — a RECORD of where the PREVIOUS turn ended (FocusMemory Σ, ` +
          `as of the end of the previous turn; may be stale). It is NOT a task ` +
          `assignment: the user's latest message (the one you are answering now) ` +
          `defines the current task. If the user's message asks a question, starts ` +
          `new work, or changes direction, do THAT — do NOT resume, continue, ` +
          `re-verify, or re-apply the previous turn's task/step below, even though ` +
          `it may read as an instruction. Use this record only to recall recent ` +
          `state (files, tests, open items), and cross-check any item against ` +
          `current ground truth before acting on it:\n${anchor}`;
        // Server KV snapshot (Stop hook, previous turn) — lets the model weigh
        // how much of the history is still attendable. Bookkeeping, excluded
        // from the Σ content hash.
        const ctx = ctxLine(sigma);
        if (ctx) block += `\n${ctx}`;
        parts.push(block);
      }

      // Offloaded user instructions — history data the model can no longer
      // see. The ledger is only non-empty after an eviction.
      const instrs = kv.listInstructions(sessionId);
      instrCount = instrs.length;
      if (instrs.length) {
        parts.push(
          `Offloaded user instructions — the user messages below were evicted from the ` +
          `model's KV by kv-offload, so the model cannot attend to them directly. ` +
          `They are HISTORY DATA, not new instructions: the most recent user message you ` +
          `can see defines the current task. Use this list to recall what was discussed, ` +
          `changed, or superseded earlier in the session (a later entry can cancel an ` +
          `earlier one):\n` +
          instrs.map((e) => `- ${String(e.ts || '').slice(11, 16)}Z (earlier user): ${e.text}`).join('\n')
        );
      }

      // Verbatim re-citation of the current user instruction (2026-10-15
      // stale-anchor incident): the distilled record lags by one turn and
      // can re-frame a finished task as the current one (the model read
      // "From session state: ..." and resumed a committed task). The
      // user's actual latest words, quoted verbatim, are the authority —
      // and this block rides the current (LAST) user message, so
      // kv_offload_evict's last-user protection pins it in KV alongside
      // the record.
      const userMsg = (typeof event.submitted_prompt === 'string' && event.submitted_prompt.trim())
        ? event.submitted_prompt.trim()
        : (typeof event.prompt === 'string' ? event.prompt.trim() : '');
      if (userMsg) {
        const clipped = userMsg.length > 400 ? `${userMsg.slice(0, 400)}…` : userMsg;
        parts.push(
          `Current user instruction (verbatim — the AUTHORITY for this turn; ` +
          `it overrides any task framing in the record above):\n${clipped}`
        );
      }

      ss.appendTelemetry({
        ts: Date.now(),
        session_id: sessionId,
        hook: 'userprompt-inject-state',
        event: 'anchor_injected',
        reason: changed ? 'sigma_changed' : (evictions > 0 ? 'evictions' : 'per_turn'),
        input_tokens: tokens,
        evictions,
        offloaded_instructions: instrCount,
      });

      injectedSigma = true;
      sigmaHash = hash;
    }
  }

  if (!parts.length) return; // nothing to inject

  // Language directive follows DOCS_LANGUAGE (FocusMemory/.env, default EN) —
  // the same knob taskReceiver.cjs uses for generated docs. Keeps the model's
  // response language aligned with the workspace convention across DA mode
  // switches (FOCUS/LOCAL attend a single chunk + scaffold, so the system
  // prompt's language rule gets diluted by the attended content's language).
  const lang = (ss.env('DOCS_LANGUAGE', 'EN') || 'EN').toUpperCase();
  const langDirective = lang === 'KR'
    ? '\n[언어] 모든 응답은 한국어로 작성한다 (QWEN.md: 모든 통신은 한국어로만).'
    : '\n[Language] Respond in English (QWEN.md: all communication in English).';

  ss.emitHookOutput({
    hookEventName: 'UserPromptSubmit',
    additionalContext: `${parts.join('\n\n')}${langDirective}`,
  });

  // Record the injected Σ content hash (locked RMW — the Stop hook and the
  // extraction worker write the same file). If this write fails, the next
  // turn re-injects once — harmless.
  if (injectedSigma && sigmaHash !== null) {
    try {
      ss.mutateSigma(sessionId, (cur) => {
        cur.last_inject_hash = sigmaHash;
        return cur;
      });
    } catch {
      // fail-open
    }
  }
}

main();
