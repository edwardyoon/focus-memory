// Eviction-triggered Σ extraction (mid-turn refresh, 2026-10-09).
//
// The Stop/UserPromptSubmit hooks only fire at TURN boundaries, so a long
// autonomous turn (reason → read → reason → read → ... for an hour) runs on
// a frozen Σ: no update, no re-injection, mid-turn collapse. The kv-offload
// eviction PUT is the only deterministic signal that does not depend on turn
// boundaries — focus-llama PUTs a segment exactly when it leaves the model's
// KV (oldest-first). Distilling the evicted segment into Σ at that moment
// keeps the state record current while the turn is still running; the
// llama-server re-presents it on every request via the DA scaffold (GET
// /v1/kv-offload/session/sigma → appended to the offloaded-chunks note).
//
// Why the eviction PUT (vs. a PostToolUse hook or a periodic server poll):
//  - The PUT payload IS the content that just left the KV → the summary
//    target matches exactly. No transcript window, no byte offsets → the
//    offset-consumption / stale-skip trigger loss (2026-10-09 Σ-freeze bug)
//    cannot happen here: the input is a closed segment, not a growing file.
//  - Idempotent: the segment key is the engine's content hash; a re-PUT of a
//    processed key (engine restart) is skipped via Σ.evict_processed_keys.
//  - No client dependency: it fires for any client of the engine.
//
// Concurrency: one worker per session (in-flight flag). Segments queued
// while a worker runs are batched into the next extraction (one 8089 call
// per batch, input capped at BUDGET_CHARS keeping the tail — the most
// recently evicted segments are the freshest state input).
//
// Fail-open throughout: the kick is fire-and-forget AFTER the putChunk
// success (the PUT response is never delayed or failed by extraction); any
// worker error → telemetry, the segments stay in the kv-offload store
// (recallable via <focus>), and the turn-boundary extraction (Stop/
// PreCompact) still covers the session.

const ss = require('./skillstate.js');
const kv = require('./kvoffload.js');

const BUDGET_CHARS = 30000;      // per-extraction input cap (PreCompact worker parity)
const LLM_TIMEOUT_MS = 120000;   // gemma-4 delta extractions land in ~5-10s; headroom for a full batch
const MAX_KEYS_TRACKED = 256;    // Σ.evict_processed_keys ledger cap

// In-memory only: a server restart drops pending segments. Acceptable — the
// segments stay in the kv-offload store (recallable via <focus>), the engine
// only re-PUTs a key after ITS OWN restart, and the turn-boundary extraction
// still covers the session.
const queues = new Map();   // sessionId -> Array<{key, text}>
const inflight = new Set(); // sessionIds with a running worker

/**
 * Enqueue one evicted segment for Σ extraction. Fire-and-forget: returns
 * immediately; the worker runs in the server process (setImmediate).
 * @param {string} sessionId
 * @param {string} key - the engine's content-hash segment key
 * @param {string} text - the evicted segment's raw text
 */
function kickEvictExtract(sessionId, key, text) {
  try {
    if (!ss.skillStateEnabled()) return;
    if (!sessionId || !key || typeof text !== 'string' || !text) return;
    if (!queues.has(sessionId)) queues.set(sessionId, []);
    queues.get(sessionId).push({ key, text });
    startWorker(sessionId);
  } catch {
    // fail-open — the PUT already succeeded; the store keeps the text
  }
}

/**
 * Start the session's extraction worker unless one is already running.
 * @param {string} sessionId
 */
function startWorker(sessionId) {
  if (inflight.has(sessionId)) return;
  inflight.add(sessionId);
  setImmediate(async () => {
    try {
      for (;;) {
        await drainQueue(sessionId);
        const q = queues.get(sessionId);
        if (!q || !q.length) break; // a kick that raced in loops once more
      }
    } catch (err) {
      ss.appendTelemetry({
        ts: Date.now(), session_id: sessionId, hook: 'evict-extract',
        event: 'worker_error', error: String((err && err.message) || err),
      });
    } finally {
      inflight.delete(sessionId);
      // Close the final race: a kick that landed after the last empty check
      // (while inflight was still set) enqueued without starting a worker.
      const q = queues.get(sessionId);
      if (q && q.length) startWorker(sessionId);
      else queues.delete(sessionId);
    }
  });
}

/**
 * Process one batch: the queued segments up to BUDGET_CHARS (FIFO — eviction
 * order, oldest first; the tail is kept when the next drain truncates).
 * @param {string} sessionId
 */
async function drainQueue(sessionId) {
  const q = queues.get(sessionId);
  if (!q || !q.length) return;
  const batch = [];
  let chars = 0;
  while (q.length) {
    const seg = q[0];
    if (batch.length && chars + seg.text.length > BUDGET_CHARS) break;
    batch.push(q.shift());
    chars += seg.text.length;
  }
  await extractBatch(sessionId, batch);
}

/**
 * Distill one batch of evicted segments into the session's Σ.
 * @param {string} sessionId
 * @param {Array<{key: string, text: string}>} batch
 */
async function extractBatch(sessionId, batch) {
  // Idempotency: skip segments already distilled (engine re-PUT after restart)
  const current = ss.loadSigma(sessionId);
  const done = new Set(Array.isArray(current.evict_processed_keys) ? current.evict_processed_keys : []);
  const fresh = batch.filter((s) => !done.has(s.key));
  if (!fresh.length) {
    ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'evict-extract', event: 'keys_already_processed', n: batch.length });
    return;
  }

  // The evicted segments in eviction order (oldest first). Truncate to the
  // tail — the most recently evicted history is the freshest state input.
  let text = fresh.map((s) => s.text).join('\n');
  if (text.length > BUDGET_CHARS) text = text.slice(-BUDGET_CHARS);

  const sigma = ss.loadSigma(sessionId);
  ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'evict-extract', event: 'extract_start', segments: fresh.length, chars: text.length });

  // callSummaryLLM never throws — it returns '' on any failure (HTTP error,
  // timeout, bad shape), so '' is the failure signal. Not marked processed:
  // the segments are simply not distilled this round (they stay recallable in
  // the store; the turn-boundary extraction still covers the session). No
  // retry loop — the engine re-PUTs a key only after an engine restart.
  let raw;
  try {
    raw = await ss.callSummaryLLM(ss.buildExtractionPrompt(sigma, text, sessionId), LLM_TIMEOUT_MS);
  } catch (err) {
    raw = '';
  }
  if (!raw) {
    ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'evict-extract', event: 'extract_failed', error: 'empty LLM response' });
    return;
  }
  const patch = ss.extractJsonPatch(raw);
  if (!patch || !Object.keys(patch).length) {
    ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'evict-extract', event: 'extract_empty', segments: fresh.length });
    return;
  }
  // Foreign-session gate (2026-10-17 incident): evicted segments are OLD
  // history — exactly where a forensic read of another session's state file
  // lives; without the gate the foreign anchor re-enters the live Σ mid-turn.
  // (filterGhostRefs is intentionally absent here — no cwd in the PUT payload.)
  const foreign = ss.filterForeignSessionRefs(patch, sessionId);
  if (foreign.removed.length) {
    ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'evict-extract', event: 'foreign_refs_filtered', removed: foreign.removed });
  }
  if (!Object.keys(patch).length) {
    ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'evict-extract', event: 'extract_empty_after_filter', segments: fresh.length });
    return;
  }

  // Mechanical recall pointers from the store (same as the PreCompact worker)
  try {
    const chunks = kv.listChunks(sessionId);
    if (chunks.length) {
      patch.recall_pointers = chunks.slice(-10).map((c) => ({ key: c.key, ts: c.ts, tokens: c.tokens, hint: c.hint }));
    }
  } catch {}
  // No filterGhostRefs here: the PUT payload carries no cwd, and the evicted
  // content is OLD history — its citations were already ghost-checked when
  // they were fresh (the turn-boundary workers apply the filter).

  // Locked merge + idempotency ledger. evict_processed_keys is a hook-internal
  // bookkeeping key: not in CONTENT_KEYS (the injection hash ignores it) and
  // mergeSigma spreads the current doc first, so it survives every merge.
  // Anchor-done gate (2026-10-15 stale-anchor incident, extended 2026-10-20):
  // the evicted segments are OLD history. When the anchor is already
  // completed/revoked, a `next` list distilled from them usually describes
  // the FINISHED task — merging it re-activates a completed task in the live
  // Σ (the incident: the model resumed a committed/pushed task from a
  // mid-turn re-presentation). The gate now distinguishes the two cases via
  // ss.anchorDoneGateAction():
  //   'strip'   — the incoming next re-derives the completed task's steps
  //               (high overlap with the anchor_done_next baseline): omit
  //               next from the patch so the merge PRESERVES the current
  //               next instead of overwriting it (the 2026-10-15 behavior).
  //   'release' — the incoming next is a genuinely NEW task (low overlap):
  //               the completed/revoked anchor is stale (premature
  //               completion-signal flip or a superseded task). Release it —
  //               clear the sticky flags, wipe the finished task's view, and
  //               let the new next merge — so the new task runs under a clean
  //               anchor instead of a frozen "COMPLETED + old next" state
  //               (the 2026-10-20 stale-anchor repetition: a sub-task
  //               completion flipped the anchor while the task continued, and
  //               strip-only semantics froze the stale next for 3h+).
  let beforeNext = [];
  let nextStripped = false;
  let anchorReleased = false;
  const written = ss.mutateSigma(sessionId, (cur) => {
    beforeNext = Array.isArray(cur.next) ? cur.next.slice() : [];
    const wasDone = cur.anchor_completed === true || cur.anchor_revoked === true;
    let p = patch;
    const gate = ss.anchorDoneGateAction(cur, p);
    if (gate.action === 'strip') {
      p = { ...p };
      delete p.next;
      nextStripped = true;
    } else if (gate.action === 'release') {
      cur.anchor_completed = false;
      cur.anchor_revoked = false;
      cur.anchor_reset_pending = false;
      cur.anchor_done_next = [];
      delete cur.confirmed;
      delete cur.hypothesis;
      delete cur.next;
      delete cur.notes;
      delete cur.task_summary;
      delete cur.current_step;
      delete cur.pending_checks;
      p = { ...p };
      delete p.anchor_completed;
      delete p.anchor_revoked;
      anchorReleased = true;
    }
    const next = ss.mergeSigma(cur, p);
    next.session_id = sessionId;
    next.updated_at = new Date().toISOString();
    const keys = Array.isArray(cur.evict_processed_keys) ? [...cur.evict_processed_keys] : [];
    for (const s of fresh) {
      if (!keys.includes(s.key)) keys.push(s.key);
    }
    next.evict_processed_keys = keys.slice(-MAX_KEYS_TRACKED);
    // One-shot context-switch marker (2026-10-20 stale-anchor fix): evict
    // extraction previously had NO reset-arming (only the turn-boundary
    // worker did), so an anchor_completed set HERE never wiped the finished
    // task's view — the stale next froze and re-injected every turn. Arm the
    // marker and store the completed task's next as the baseline the gate
    // above compares incoming next lists against.
    const isDone = next.anchor_revoked === true || next.anchor_completed === true;
    if (isDone && !wasDone) {
      next.anchor_reset_pending = true;
      next.anchor_done_next = Array.isArray(next.next) ? next.next.slice() : [];
    }
    return next;
  });
  if (!written) return;
  // Mid-turn re-presentation visibility (incident follow-up 4): the DA
  // scaffold re-presents Σ on every request after this merge, so the
  // before/after `next` state here is the forensic record of WHAT the model
  // was re-presented mid-turn.
  const afterNext = Array.isArray(written.next) ? written.next : [];
  ss.appendTelemetry({
    ts: Date.now(),
    session_id: sessionId,
    hook: 'evict-extract',
    event: 'extracted',
    segments: fresh.length,
    keys: Object.keys(patch),
    next_before: beforeNext,
    next_after: afterNext,
    ...(nextStripped ? { next_stripped_anchor_done: true } : {}),
    ...(anchorReleased ? { anchor_released_new_task: true } : {}),
    ...(beforeNext.length === 0 && afterNext.length > 0 ? { next_reactivated: true } : {}),
    // Large-evict wave marker (2026-10-17): a big eviction batch (163-class)
    // is the forensic signature of the stale-framing window — joins
    // next_before/after as the record for it.
    ...(fresh.length >= 8 ? { evict_wave: true } : {}),
  });
}

module.exports = { kickEvictExtract };
