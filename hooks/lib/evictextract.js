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
    raw = await ss.callSummaryLLM(ss.buildExtractionPrompt(sigma, text), LLM_TIMEOUT_MS);
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
  const written = ss.mutateSigma(sessionId, (cur) => {
    const next = ss.mergeSigma(cur, patch);
    next.session_id = sessionId;
    next.updated_at = new Date().toISOString();
    const keys = Array.isArray(cur.evict_processed_keys) ? [...cur.evict_processed_keys] : [];
    for (const s of fresh) {
      if (!keys.includes(s.key)) keys.push(s.key);
    }
    next.evict_processed_keys = keys.slice(-MAX_KEYS_TRACKED);
    return next;
  });
  if (!written) return;
  ss.appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'evict-extract', event: 'extracted', segments: fresh.length, keys: Object.keys(patch) });

  // Best-effort work_memory dual-write (stable per-session point, upsert)
  try {
    await ss.recordCheckpoint(written, '', 'eviction');
  } catch {}
}

module.exports = { kickEvictExtract };
