#!/usr/bin/env node
// PreCompact hook — SKILL.state: kick off structured execution state (Σ)
// extraction from the pre-compaction transcript.
//
// Two modes:
//   parent (default)  — spawns a detached worker, emits the summarizer nudge,
//                       exits 0 in milliseconds. Native compaction is NEVER
//                       blocked by the LLM call.
//   --worker <event>  — the detached child: transcript tail → SUMMARY_LLM
//                       state-patch extraction (JSON only, no prose) →
//                       null-deletion merge into
//                       ~/.qwen/tmp/focus-memory/state/<sid>.json →
//                       dual-write a work_memory "state_checkpoint" point.
//
// Why async: the transcript JSONL keeps its full raw history after
// compaction (qwen only appends a `chat_compression` system record), so the
// extraction can run in parallel with the native compaction side-query and
// the Σ is ready by the time SessionStart(source=compact) re-injects it.
// For small contexts the native summary can finish before the worker — in
// that case the injection is simply skipped this round (fail-open); the Σ
// still lands for the next compaction and in work_memory.
//
// Feature gate: FOCUSMEMORY_SKILLSTATE=on — any other value / unset returns
// immediately at the entry, so with the gate off the existing auto-recall +
// Hard Gate structure is byte-for-byte untouched.
//
// Fail-open (same principle as the Hard Gate hooks): any error → silent exit 0;
// native compaction proceeds exactly as if this hook did not exist.

const fs = require('fs');
const { spawn } = require('child_process');
const ss = require('./lib/skillstate.js');
const kv = require('./lib/kvoffload.js');

const LLM_TIMEOUT_MS = 120000; // worker is detached — no hook timeout constrains it
// Transcript window for extraction (rendered chars). Local 27B prefill is
// ~0.5ms/char; 30k keeps the worker in the ~1min range.
const BUDGET_CHARS = Math.max(2000, parseInt(process.env.FOCUSMEMORY_SKILLSTATE_MAX_CHARS || '30000', 10) || 30000);
// User-message guarantee (a39ee3d9 fix): extend the tail past the budget, up
// to this cap, until at least TAIL_MIN_USER user entries are present — a 30k
// all-assistant tail held zero user messages, so anchor_completed could never
// fire. Cap is 2x budget (60k chars ≈ 19k tokens): the 8089 server runs a
// 28k-token ctx, so the worst-case prompt (tail + schema + generation) must
// stay under it.
const TAIL_MAX_CHARS = Math.max(BUDGET_CHARS, parseInt(process.env.FOCUSMEMORY_SKILLSTATE_TAIL_MAX_CHARS || String(BUDGET_CHARS * 2), 10) || BUDGET_CHARS * 2);
const TAIL_MIN_USER = Math.max(1, parseInt(process.env.FOCUSMEMORY_SKILLSTATE_TAIL_MIN_USER || '2', 10) || 2);

/**
 * Worker mode — the actual extraction (runs detached, no hook timeout).
 * @param {object} event - PreCompact event JSON
 * @returns {Promise<void>}
 */
async function runWorker(event) {
  const sessionId = event.session_id;
  if (!sessionId) return;

  // Delta extraction: send only the transcript content since the last
  // extraction — seconds of prefill, not the 40-60s whole-tail calls. The
  // offset is the state file's last_extraction_transcript_bytes (written by
  // the previous extraction's merge). No offset at all (fresh session,
  // first compaction) → full-tail read with the user-message guarantee.
  const sigma = ss.loadSigma(sessionId);
  const fromBytes = Number(sigma.last_extraction_transcript_bytes) || 0;
  const sizeAtRead = (() => {
    try { return fs.statSync(event.transcript_path).size; } catch { return 0; }
  })();
  const transcriptText = fromBytes > 0
    ? ss.extractTranscriptDelta(event.transcript_path, fromBytes, { maxChars: BUDGET_CHARS })
    : ss.extractTranscriptTail(event.transcript_path, BUDGET_CHARS, { maxChars: TAIL_MAX_CHARS, minUserEntries: TAIL_MIN_USER });
  if (!transcriptText) {
    // Previously a silent return — that silence is what made the
    // first-extraction miss undiagnosable (2026-10-09).
    ss.appendTelemetry({
      ts: Date.now(),
      session_id: sessionId,
      hook: 'precompact-extract-state',
      event: 'extract_empty_delta',
      trigger: event.trigger,
      from_bytes: fromBytes,
      size: sizeAtRead,
    });
    return; // empty window or unreadable transcript — nothing to extract
  }

  // Stale-worker guard: the transcript grows when the user starts a new
  // turn. If it grew during the LLM call, the next extraction (the next
  // compaction) will see the newer content — merging this stale patch
  // (confirmed / next / anchor_revoked) would clobber the newer state, so
  // skip the merge.

  const rawOutput = await ss.callSummaryLLM(ss.buildExtractionPrompt(sigma, transcriptText, sessionId), LLM_TIMEOUT_MS);

  let sizeNow = 0;
  try { sizeNow = fs.statSync(event.transcript_path).size; } catch {}
  if (sizeNow > sizeAtRead) {
    ss.appendTelemetry({
      ts: Date.now(),
      session_id: sessionId,
      hook: 'precompact-extract-state',
      event: 'extract_stale_skipped',
      trigger: event.trigger,
    });
    return;
  }

  const rawPatch = ss.extractJsonPatch(rawOutput);
  if (!rawPatch || Object.keys(rawPatch).length === 0) {
    ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state', event: 'extract_failed', trigger: event.trigger });
    return; // fail-open — compaction proceeds without state
  }

  // Anti-confabulation propagation gate: drop new items citing dated todos
  // files that do not exist on disk (2026-09-26 incident — a ghost citation
  // in assistant prose became a Σ pending item re-injected into later
  // sessions). Runs before the merge; existing Σ content is untouched.
  const { patch, removed: ghostRemoved } = ss.filterGhostRefs(rawPatch, event.cwd);
  if (ghostRemoved.length) {
    ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state', event: 'ghost_refs_filtered', trigger: event.trigger, removed: ghostRemoved });
  }
  // Foreign-session gate (2026-10-17 incident): drop new items citing another
  // session's state file (a forensic read of state/29a17fe5-*.json re-latched
  // a later session onto that session's task). Same patch-only scope as the
  // ghost filter.
  const foreign = ss.filterForeignSessionRefs(patch, sessionId);
  if (foreign.removed.length) {
    ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state', event: 'foreign_refs_filtered', trigger: event.trigger, removed: foreign.removed });
  }
  if (Object.keys(patch).length === 0) {
    ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state', event: 'extract_empty_after_filter', trigger: event.trigger });
    return;
  }

  // Recall pointers: the offloaded (evicted) segments the model can re-load via
  // <focus> after compaction. Sourced from the kv-offload store (the recall
  // source of truth), NOT the LLM. A snapshot (KEY_RULES 'replace').
  try {
    const chunks = kv.listChunks(sessionId);
    if (chunks.length) {
      patch.recall_pointers = chunks.slice(-10).map((c) => ({
        key: c.key, ts: c.ts, tokens: c.tokens, hint: c.hint,
      }));
    }
  } catch { /* fail-open — anchor just omits the recall line */ }

  // Merge inside one locked read-modify-write: the base Σ was loaded before
  // the LLM call, so a concurrent Stop hook may have updated bookkeeping
  // keys (last_input_tokens, turn_count, transcript_path,
  // last_turn_completion_signal) during that window. Merging against a fresh
  // read inside the lock is lost-update-safe without a post-hoc key re-copy.
  // Drift measurement (2026-10-19): the pre-merge confirmed list (stale
  // citation baseline) and the aged-hypothesis report are captured inside
  // the same locked RMW as the merge.
  let agedHypo = [];
  let preConfirmed = [];
  let nextStripped = false;
  let anchorReleased = false;
  const written = ss.mutateSigma(sessionId, (current) => {
    preConfirmed = Array.isArray(current.confirmed) ? current.confirmed : [];
    const wasDone = current.anchor_revoked === true || current.anchor_completed === true;
    let p = patch;
    // Anchor-done gate (2026-10-20 stale-anchor fix, same as evict-extract):
    // a `next` distilled while the anchor is already completed/revoked is
    // either a stale re-derivation of the finished task ('strip' — preserve
    // the current list) or a genuinely new task ('release' — clear the
    // premature/sticky anchor so the new task runs under a clean anchor).
    const gate = ss.anchorDoneGateAction(current, p);
    if (gate.action === 'strip') {
      p = { ...p };
      delete p.next;
      nextStripped = true;
    } else if (gate.action === 'release') {
      current.anchor_completed = false;
      current.anchor_revoked = false;
      current.anchor_reset_pending = false;
      current.anchor_done_next = [];
      delete current.confirmed;
      delete current.hypothesis;
      delete current.next;
      delete current.notes;
      delete current.task_summary;
      delete current.current_step;
      delete current.pending_checks;
      p = { ...p };
      delete p.anchor_completed;
      delete p.anchor_revoked;
      anchorReleased = true;
    }
    const next = ss.mergeSigma(current, p);
    next.session_id = sessionId;
    next.updated_at = new Date().toISOString();
    // One-shot context-switch marker (2026-10-03): the first extraction
    // that flips a sticky anchor flag from unset to true marks the
    // current-view keys (confirmed / hypothesis / next) as the finished
    // task's. The UserPromptSubmit hook consumes the marker on the NEXT
    // user message — exactly one Σ reset per completion, so the new task's
    // re-populated keys (merge rule: replace) survive all later turns. The
    // sticky flags themselves never re-transition, which is what makes the
    // marker a reliable one-shot without a turn counter. (2026-10-20: the
    // release path above is the one sanctioned re-transition — a genuinely
    // new task clears a premature anchor, and the marker re-arms normally.)
    const isDone = next.anchor_revoked === true || next.anchor_completed === true;
    if (isDone && !wasDone) {
      next.anchor_reset_pending = true;
      // Completed task's next = the gate's re-derivation baseline.
      next.anchor_done_next = Array.isArray(next.next) ? next.next.slice() : [];
    }
    // Hypothesis age stamps (hook-internal bookkeeping, measurement only).
    agedHypo = ss.updateHypoStamps(next, Number(current.turn_count) || 0);
    return next;
  });
  if (written) {
    ss.recordCheckpoint(written, event.cwd, event.trigger).catch(() => {});
    // B4 pin release: mirror the sticky release flags into the kv-offload
    // store so the focus-llama engine can release the first-user-message pin
    // at its next eviction plan (GET /v1/kv-offload/session). Two triggers:
    // anchor_revoked (user cancelled/superseded the original request) and
    // anchor_completed (original task finished AND a newer user request
    // superseded it — 2026-10-03 extension; without it the stale pinned
    // request re-latches the model after its completion evidence is evicted,
    // incident cde14958). Idempotent + sticky on the store side too; a write
    // failure only delays the release by one extraction (fail-open, pin stays).
    if (written.anchor_revoked === true || written.anchor_completed === true) {
      const res = kv.setPinReleased(sessionId);
      if (!res.ok) {
        ss.appendTelemetry({
          ts: Date.now(),
          session_id: sessionId,
          hook: 'precompact-extract-state',
          event: 'pin_release_write_failed',
          trigger: event.trigger,
          reason: res.reason,
        });
      }
    }
  }
  // Drift base-rate telemetry (2026-10-19, measurement only — no item is
  // dropped or rewritten, nothing is model-facing): (a) hypotheses that
  // have aged 3+ turns without leaving the list, (b) NEW confirmed items
  // citing files the segment's tool calls never touched, (c) EXISTING
  // confirmed items whose cited file was edited in the segment. The base
  // rates decide whether any of these becomes a real gate.
  if (written) {
    const { touched, edited } = ss.segmentCallFiles(transcriptText);
    if (agedHypo.length) {
      ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'drift', event: 'drift_hypo_aged', items: agedHypo });
    }
    const ghosts = [];
    for (const item of Array.isArray(patch.confirmed) ? patch.confirmed : []) {
      if (typeof item !== 'string' || !item || preConfirmed.includes(item)) continue;
      const missing = ss.citedFiles(item).filter((c) => ![...touched].some((t) => ss.pathRefersTo(c, t)));
      if (missing.length) ghosts.push({ item, refs: missing });
    }
    if (ghosts.length) {
      ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'drift', event: 'drift_ghost_ref', items: ghosts });
    }
    const stale = [];
    for (const item of preConfirmed) {
      if (typeof item !== 'string' || !item) continue;
      const hit = ss.citedFiles(item).filter((c) => [...edited].some((e) => ss.pathRefersTo(c, e)));
      if (hit.length) stale.push({ item, files: hit });
    }
    if (stale.length) {
      ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'drift', event: 'drift_stale_citation', items: stale });
    }
  }
  ss.appendTelemetry({
    ts: Date.now(),
    session_id: sessionId,
    hook: 'precompact-extract-state',
    event: 'extracted',
    trigger: event.trigger,
    keys: Object.keys(patch),
    ...(nextStripped ? { next_stripped_anchor_done: true } : {}),
    ...(anchorReleased ? { anchor_released_new_task: true } : {}),
  });
}

/**
 * Parent mode — spawn the detached worker and return immediately.
 * @param {object} event - PreCompact event JSON
 */
function spawnWorker(event) {
  try {
    const child = spawn(process.execPath, [__filename, '--worker', JSON.stringify(event)], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch (err) {
    console.error(`[skillstate] worker spawn failed: ${err.message}`);
  }
}

function main() {
  // Worker mode (detached child)
  if (process.argv[2] === '--worker') {
    if (!ss.skillStateEnabled()) return;
    let event = {};
    try {
      event = JSON.parse(process.argv[3] || '{}');
    } catch {
      return;
    }
    // The pending LLM fetch keeps the event loop alive until the work is done;
    // a crash must not take down anything else — log the reason for diagnosis.
    runWorker(event).catch((err) => {
      ss.appendTelemetry({
        ts: Date.now(),
        session_id: event.session_id || '',
        hook: 'precompact-extract-state',
        event: 'worker_error',
        error: String((err && err.message) || err),
      });
    });
    return;
  }

  // Parent mode — feature gate first: off means zero behavior change.
  if (!ss.skillStateEnabled()) return;

  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  if (!event.session_id) return;

  spawnWorker(event);

  let nudge =
    'FocusMemory SKILL.state: a structured execution state (files touched, test status, current step, pending checks, decisions) is being extracted from this conversation in parallel and persisted separately. ' +
    'In your summary, do NOT re-enumerate those facts — focus on decisions, rationale, and open issues not captured as structured state. ' +
    'When naming the session\'s current or latest request, first locate the ACTUAL last user message in the transcript and base that section on it (quote it, with its timestamp when present); if the original task is completed or superseded, say so explicitly — do NOT re-date an older message as the latest request.';
  // DA on: keep dead [[da:N]] marker strings out of the summary. The
  // focus-llama scanner (tail anchoring) already makes copied markers
  // harmless — this only lowers the copy frequency (defense in depth).
  if (['on', '1', 'true'].includes((ss.env('FOCUSMEMORY_DA', '') || '').toLowerCase())) {
    nudge += ' Do NOT reproduce DA marker strings ([[da:...]] / <da:...>) or their instruction blocks in the summary.';
  }

  ss.emitHookOutput({
    hookEventName: 'PreCompact',
    additionalContext: nudge,
  });
}

main();
