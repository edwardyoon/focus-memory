#!/usr/bin/env node
// UserPromptSubmit hook — SKILL.state per-turn state anchor injection.
//
// Injection gate (2026-10-09): inject when the model-facing Σ CONTENT
// changed since the last injection (sha256 over the content keys, excluding
// hook-internal bookkeeping and the server-value `ctx:` line), OR when the
// session has offloaded KV (kv_state.evictions > 0). Before the first
// eviction the full transcript is attendable, so an unchanged Σ is NOT
// re-injected (the old 50k-token threshold is gone — a short session with a
// changed Σ gets its anchor; a long session with an unchanged Σ does not
// pay for a repeated one). From the first eviction on, part of the history
// is no longer attendable, so the record is re-presented every turn.
// Post-compaction is covered by the hash: the extraction worker rewrites Σ
// around the compaction, so the hash changes and the anchor lands.
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
// Session notes index (2026-10-09, plans/continous_work.md FR-3): a third,
// independent block — the model's own work-note index (key [status]
// summary, ≤30 entries, ~450 tokens), injected whenever non-empty. Gated by
// FOCUSMEMORY_NOTES=on; the Σ blocks stay gated by FOCUSMEMORY_SKILLSTATE=on.
// The hook also stamps the active-session registry (notes.js) so the
// note_put/note_get/note_list MCP tools can resolve this session's identity
// (the MCP call itself carries no session id).
//
// Gated by FOCUSMEMORY_SKILLSTATE=on / FOCUSMEMORY_NOTES=on (both off/unset
// → immediate no-op, zero behavior change). Fail-open: any error → silent
// exit 0, the turn proceeds without the injection.

const fs = require('fs');
const crypto = require('crypto');
const ss = require('./lib/skillstate.js');
const kv = require('./lib/kvoffload.js');
const notes = require('./lib/notes.js');

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
 *   3. the session notes index (notes, FR-3).
 * Blocks 1-2 are gated together on "Σ content changed OR evictions > 0" and
 * ride the current (last) user message, so kv_offload_evict's last-user
 * protection keeps them in the KV. Block 3 is injected whenever non-empty.
 * @returns {void}
 */
function main() {
  const ssOn = ss.skillStateEnabled();
  const notesOn = notes.notesEnabled();
  if (!ssOn && !notesOn) return; // both gates off → zero behavior change

  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = event.session_id;
  if (!sessionId) return;

  // Stamp the active-session registry so the note_* MCP tools (which carry
  // no session id) resolve against THIS session. UserPromptSubmit fires at
  // turn start — before any of this turn's tool calls — so the freshest
  // entry at note_put time is the calling session.
  try {
    notes.stampActiveSession(sessionId, 'userpromptsubmit');
  } catch { /* fail-open */ }

  const parts = [];
  let injectedSigma = false;
  let sigmaHash = null;

  if (ssOn) {
    let sigma = ss.loadSigma(sessionId);

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

    // Injection gate (2026-10-09): re-inject when the model-facing Σ content
    // changed since the last injection, OR when the session has offloaded KV
    // (evictions > 0 — cumulative per session, so from the first eviction on
    // the record is re-presented every turn, matching the instruction-ledger
    // block's "non-empty → inject" behavior). The 50k-token threshold is gone:
    // before the first eviction the full transcript is attendable, so an
    // unchanged Σ costs nothing by staying out.
    if (hasContent(sigma)) {
      const tokens = Number(sigma.last_input_tokens) || 0;
      const hash = sigmaContentHash(sigma);
      const evictions = Number(sigma.kv_state && sigma.kv_state.evictions) || 0;
      const changed = sigma.last_inject_hash !== hash;
      if (changed || evictions > 0) {
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
        // see. The ledger is only non-empty after an eviction, which already
        // forced injection via the evictions > 0 branch above.
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

        ss.appendTelemetry({
          ts: Date.now(),
          session_id: sessionId,
          hook: 'userprompt-inject-state',
          event: 'anchor_injected',
          reason: changed ? 'sigma_changed' : 'evictions',
          input_tokens: tokens,
          evictions,
          offloaded_instructions: instrCount,
        });

        injectedSigma = true;
        sigmaHash = hash;
      } else {
        ss.appendTelemetry({
          ts: Date.now(),
          session_id: sessionId,
          hook: 'userprompt-inject-state',
          event: 'inject_skipped',
          reason: 'unchanged',
          input_tokens: tokens,
          evictions,
        });
      }
    }
  }

  // Session notes index (FR-3) — independent of the Σ gate: injected
  // whenever the session has notes. Non-empty only after the first
  // note_put, so the steady-state cost is the index itself (~450 tokens).
  if (notesOn) {
    let idx = '';
    try {
      idx = notes.renderNotesIndex(sessionId);
    } catch { /* fail-open */ }
    if (idx) {
      parts.push(idx);
      ss.appendTelemetry({
        ts: Date.now(),
        session_id: sessionId,
        hook: 'userprompt-inject-state',
        event: 'notes_index_injected',
        chars: idx.length,
        approx_tokens: Math.ceil(idx.length / 4),
      });
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
