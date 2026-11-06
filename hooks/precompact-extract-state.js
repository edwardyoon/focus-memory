#!/usr/bin/env node
// PreCompact hook — SKILL.state: kick off structured execution state (Σ)
// extraction from the pre-compaction transcript.
//
// Two modes:
//   parent (default)  — spawns a detached worker, emits the summarizer nudge,
//                       exits 0 in milliseconds. Native compaction is NEVER
//                       blocked by the LLM call.
//   --worker <event> — the detached child: transcript tail → state-patch
//                       extraction (JSON only, no prose) → null-deletion merge
//                       into ~/.qwen/tmp/focus-memory/state/<sid>.json.
//                       Extraction always uses the lightweight SUMMARY_LLM
//                       (gemma-4): the Σ is a reference record re-injected at
//                       the next compaction, never a live model-facing payload.
//
// Why async: the transcript JSONL keeps its full raw history after
// compaction (qwen only appends a `chat_compression` system record), so the
// extraction can run in parallel with the native compaction side-query and
// the Σ is ready by the time SessionStart(source=compact) re-injects it.
// For small contexts the native summary can finish before the worker — in
// that case the injection is simply skipped this round (fail-open); the Σ
// still lands for the next compaction.
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

// Item 10: 300s — the MAIN_LLM (27B, thinking) sigma-generation paths measure
// 15-40s per pass; the worker is detached, so a long budget only stretches
// compaction duration, never a user-facing request.
const LLM_TIMEOUT_MS = 300000;
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
 * Topic scoping for the chain-derived next (2026-10-29 stale-next fix):
 * the topic_keys this session ACTIVELY maintains — i.e. appears in its own
 * remember_decision calls (the tool-call lines), not in search results or
 * prose (a passive mention of another session's chain must not steer this
 * one's Σ). Full-file scan: the worker is detached (no hook timeout) and
 * transcripts stay in the low-MB range.
 * @param {string} transcriptPath - the session transcript JSONL
 * @returns {Set<string>} topic_keys (empty when the transcript is unreadable
 *   or holds no remember_decision calls)
 */
function scanTranscriptTopics(transcriptPath) {
  const topics = new Set();
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.includes('remember_decision') || !line.includes('topic_key')) continue;
      for (const m of line.matchAll(/"topic_key"\s*:\s*"([a-zA-Z0-9_-]+)"/g)) topics.add(m[1]);
    }
  } catch { /* unreadable transcript → no scoping → no chain override */ }
  return topics;
}

/**
 * S7 (plan §4.3) — history Δ at compaction. Absorb the transcript region
 * [hist_last_bytes, sizeAtRead) — the content that leaves the model's
 * context via this compaction — into the cumulative history layer (hist_*).
 * Same pipeline as POST /sigma/refresh (extractTranscriptRange → LLM strip
 * prompt → gateStripPatch → mergeStripPatch) with the rule-based fallback,
 * so the Σ lineage never breaks when the LLM is down. hist_last_bytes
 * advances only on a read chunk; a capped region rides the next
 * refresh/compaction.
 * @param {string} sessionId
 * @param {string} transcriptPath
 * @param {number} sizeAtRead - transcript size captured before any LLM call
 * @param {string} cwd - session working directory for the ghost-ref gate (review item 9)
 * @returns {Promise<void>}
 */
async function runHistoryAbsorb(sessionId, transcriptPath, sizeAtRead, cwd = '') {
  // Item 17: cross-process claim — the POST /sigma/refresh route (the server
  // process) may be absorbing the same [hist_last_bytes, ...) region. The
  // per-process single-flight map can't coordinate the two processes, so a
  // fresh claim by the other path makes this one skip. No data is lost (the
  // merge is a dedup-safe union and hist_last_bytes is monotonic) — the
  // remainder rides the next refresh/compaction.
  const claim = ss.claimHistAbsorb(sessionId);
  if (!claim) return; // the other path is in-flight — it will absorb
  try {
    await doHistoryAbsorb(sessionId, transcriptPath, sizeAtRead, cwd);
  } finally {
    ss.releaseHistAbsorb(sessionId, claim);
  }
}

/**
 * S7 (plan §4.3) — the actual history absorb (called under the item-17 claim
 * from runHistoryAbsorb). Absorb the transcript region [hist_last_bytes,
 * sizeAtRead) into the cumulative history layer (hist_*). Same pipeline as
 * POST /sigma/refresh (extractTranscriptRange → LLM strip prompt →
 * gateStripPatch → mergeStripPatch) with the rule-based fallback.
 * @param {string} sessionId
 * @param {string} transcriptPath
 * @param {number} sizeAtRead - transcript size captured before any LLM call
 * @param {string} cwd - session working directory for the ghost-ref gate (review item 9)
 * @returns {Promise<void>}
 */
async function doHistoryAbsorb(sessionId, transcriptPath, sizeAtRead, cwd = '') {
  const sigma = ss.loadSigma(sessionId);
  const fromBytes = Math.max(0, Number(sigma.hist_last_bytes) || 0);
  if (sizeAtRead <= fromBytes) return; // nothing new since the last absorb
  const range = ss.extractTranscriptRange(transcriptPath, fromBytes, sizeAtRead, { maxChars: BUDGET_CHARS });
  if (range.consumed <= fromBytes) return; // unreadable region — retry next pass
  let patch = {};
  // plan §5.5/§7: on LLM failure hold hist_last_bytes so the next compaction
  // re-reads the region and a later LLM pass can capture its text facts.
  let advanceBytes = false;
  if (range.text.trim()) {
    try {
      const out = await ss.callSummaryLLM(
        ss.buildStripExtractionPrompt(range.text, sessionId),
        LLM_TIMEOUT_MS,
        { useMainLLM: true, maxTokens: 30000 }
      );
      const parsed = ss.extractJsonPatch(out);
      if (!parsed || typeof parsed !== 'object') throw new Error('no JSON patch in LLM output');
      const gated = ss.gateStripPatch(parsed, sessionId, cwd);
      if (gated.removed.length) {
        // P1-1: log the gate drop rate (dropped / total input items)
        const byReason = {};
        for (const r of gated.removed) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
        ss.appendTelemetry({
          ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state',
          event: 'gate_dropped', dropped: gated.removed.length, total: gated.total || 0,
          reasons: Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(','),
        });
      }
      patch = gated.patch;
      advanceBytes = true; // LLM captured the region's text — safe to advance
    } catch (err) {
      ss.appendTelemetry({
        ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state',
        event: 'hist_absorb_llm_failed', error: String((err && err.message) || err),
      });
      patch = ss.ruleHistFromEntries(range.entries);
      ss.gateStripPatch(patch, sessionId, cwd, { skipEvidence: true });
    }
  } else {
    // No renderable text (e.g. all tool-result lines) — structural facts only.
    patch = ss.ruleHistFromEntries(range.entries);
    ss.gateStripPatch(patch, sessionId, cwd, { skipEvidence: true });
    advanceBytes = true; // nothing for a later LLM pass to find
  }
  const capped = range.consumed < sizeAtRead;
  ss.mutateSigma(sessionId, (s) => {
    let next = Object.keys(patch).length ? ss.mergeStripPatch(s, patch) : { ...s };
    if (advanceBytes && range.consumed > (Number(s.hist_last_bytes) || 0)) next = { ...next, hist_last_bytes: range.consumed };
    return next;
  });
  ss.appendTelemetry({
    ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state',
    event: 'hist_absorbed', from: fromBytes, to: sizeAtRead, consumed: range.consumed,
    keys: Object.keys(patch), ...(capped ? { capped: true } : {}),
  });
}

/**
 * S7 (plan §4.3) — one consolidation pass. When a text history key is near
 * its cap, a single LLM call rewrites the text keys into milestone lines
 * within the caps (compress, don't drop). Replaces only the keys present in
 * the sanitized output; a foreign key or non-string item rejects the whole
 * output (null → layer untouched). Any failure leaves the layer as-is — the
 * cap-drop in mergeStripPatch is the fallback.
 * @param {string} sessionId
 * @param {object} sigma - the freshly written Σ (post history-absorb)
 * @returns {Promise<void>}
 */
async function runHistoryConsolidation(sessionId, sigma) {
  if (!ss.historyNeedsConsolidation(sigma)) return;
  try {
    const out = await ss.callSummaryLLM(
      ss.buildConsolidationPrompt(sigma, sessionId),
      LLM_TIMEOUT_MS,
      { useMainLLM: true, maxTokens: 30000 }
    );
    const clean = ss.sanitizeConsolidatedPatch(ss.extractJsonPatch(out));
    if (!clean) {
      ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state', event: 'hist_consolidation_rejected' });
      return;
    }
    ss.mutateSigma(sessionId, (s) => {
      const next = { ...s };
      for (const k of Object.keys(clean)) next[k] = clean[k]; // replace, not union — a rewrite
      return next;
    });
    ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state', event: 'hist_consolidated', keys: Object.keys(clean) });
  } catch (err) {
    ss.appendTelemetry({
      ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state',
      event: 'hist_consolidation_failed', error: String((err && err.message) || err),
    });
  }
}

/**
 * Worker mode — the actual extraction (runs detached, no hook timeout).
 * @param {object} event - PreCompact event JSON
 * @returns {Promise<void>}
 */
async function runWorker(event) {
  const sessionId = event.session_id;
  if (!sessionId) return;

  // Extraction model: always the lightweight SUMMARY_LLM (gemma-4) — the Σ
  // is a reference record re-injected at the next compaction, never a live
  // model-facing payload, so the lightweight model is enough.
  const callLLM = ss.callSummaryLLM;

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
  // S7 (plan §4.3): history-layer maintenance — runs on EVERY worker pass,
  // before the work-state early returns (hist_last_bytes and
  // last_extraction_transcript_bytes track different regions): absorb the
  // content about to leave via this compaction, then consolidate a near-cap
  // text key. Both fail-open — compaction never depends on them.
  try {
    await runHistoryAbsorb(sessionId, event.transcript_path, sizeAtRead, event.cwd);
    await runHistoryConsolidation(sessionId, ss.loadSigma(sessionId));
  } catch (err) {
    ss.appendTelemetry({
      ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state',
      event: 'hist_maintenance_error', error: String((err && err.message) || err),
    });
  }
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

  // Chain-derived next (2026-10-29 stale-next fix): the DB checklist is the
  // authoritative source for outstanding steps — fetch it BEFORE the LLM
  // call so (1) the extractor prompt shows the real state and (2) the merge
  // can override the LLM's re-derived `next` with the deterministic list
  // even when the LLM output is empty or bad. Scoped to this session's own
  // remember_decision topics; fail-open to [] (the LLM-derived next stands).
  let todoChains = [];
  try {
    const topics = scanTranscriptTopics(event.transcript_path);
    if (topics.size) todoChains = await ss.fetchOpenTodoChains([...topics]);
  } catch { /* fail-open — LLM-derived next stands */ }

  const rawOutput = await callLLM(
    ss.buildExtractionPrompt(sigma, transcriptText, sessionId, todoChains),
    LLM_TIMEOUT_MS,
    { useMainLLM: true, maxTokens: 30000 }
  );

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
    if (!todoChains.length) {
      ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state', event: 'extract_failed', trigger: event.trigger });
      return; // fail-open — compaction proceeds without state
    }
    // LLM extraction failed but the chains are deterministic — land the
    // chain-derived next alone (the stale-next fix must not depend on the
    // LLM being up).
    ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state', event: 'extract_failed_chain_only', trigger: event.trigger });
  }

  // Anti-confabulation propagation gate: drop new items citing dated todos
  // files that do not exist on disk (2026-09-26 incident — a ghost citation
  // in assistant prose became a Σ pending item re-injected into later
  // sessions). Runs before the merge; existing Σ content is untouched.
  // (rawPatch may be null when only the deterministic chain next is landing.)
  const { patch, removed: ghostRemoved } = ss.filterGhostRefs(rawPatch || {}, event.cwd);
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
  // Deterministic next (2026-10-29 stale-next fix): chains grounded in THIS
  // transcript override the LLM's re-derivation — the incident was a
  // finished task's steps lingering in Σ and re-latching the model after
  // compaction. Unchecked steps in chain order; when every chain is done,
  // next is cleared so the finished task's steps cannot linger. No grounded
  // chains → the LLM's next stands (fail-open).
  if (todoChains.length) {
    const derived = [];
    for (const t of todoChains) for (const step of t.unchecked) derived.push(step);
    patch.next = derived.slice(0, 10);
    ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'precompact-extract-state', event: 'next_from_chains', trigger: event.trigger, chains: todoChains.length, steps: derived.length });
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
  // keys (last_input_tokens, transcript_path,
  // last_turn_completion_signal) during that window. Merging against a fresh
  // read inside the lock is lost-update-safe without a post-hoc key re-copy.
  let nextStripped = false;
  let anchorReleased = false;
  const written = ss.mutateSigma(sessionId, (current) => {
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
    return next;
  });
  if (written) {
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
  ss.appendTelemetry({
    ts: Date.now(),
    session_id: sessionId,
    hook: 'precompact-extract-state',
    event: 'extracted',
    trigger: event.trigger,
    keys: Object.keys(patch),
    ...(nextStripped ? { next_stripped_anchor_done: true } : {}),
    ...(anchorReleased ? { anchor_released_new_task: true } : {}),
    ...(todoChains.length ? { next_from_chains: todoChains.length } : {}),
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
