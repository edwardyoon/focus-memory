#!/usr/bin/env node
// Stop hook — SKILL.state per-Stop state-change detection + context-growth
// fallback checkpoint.
//
// Runs at the end of every turn. Three independent extraction triggers:
//   1. state change (primary): a mutating tool call (edit / write_file /
//      remember_decision) was logged since the last extraction.
//   2. context growth (fallback): input_tokens grew INTERVAL (default 50k)
//      past the last extraction — covers semantic drift that involves no
//      file change (decisions made in prose only).
//   3. new user message (B2): a REAL user message (transcript entry type
//      "user" with a text part; tool results are a separate entry type)
//      arrived since the last extraction. Triggers 1-2 both miss prose-only
//      turns — which is exactly where task changes and CANCELLATIONS arrive.
//      2026-09-28 incident: the cancellation turn was prose-only, so Σ (and
//      the pin-release flag derived from it) went stale while the pinned
//      cancelled request kept steering the model. Cost: one detached
//      extraction call per user message (no user-visible latency).
//
// Either trigger spawns the SAME detached Σ extraction worker PreCompact
// uses (precompact-extract-state.js --worker) — zero user-facing latency,
// warm checkpoints (a crash mid-session leaves a recent Σ on disk).
//
// Regardless of trigger, last_input_tokens is recorded every turn: the
// UserPromptSubmit anchor hook (userprompt-inject-state.js) reads it as its
// injection threshold, so it must track the current context size even on
// turns where nothing is extracted.
//
// Why Stop: it is the only existing qwen-code hook whose payload carries
// contextUsage (input_tokens / context_limit / context_usage) — the token
// signal needed to gate on context growth.
//
// Loop guard: when a trigger fires, last_checkpoint_tokens is set to the
// current input_tokens (re-gating the growth trigger) and
// last_extraction_log_bytes to the current tool-log size (re-basing the
// state-change trigger), so a re-entrant Stop (or a stop-hook "continue"
// loop) cannot re-fire on work that was already counted. We do NOT gate on
// stop_hook_active (that field is hard-coded true on the messageBus Stop
// path, so gating on it would disable the hook entirely).
//
// Gated by FOCUSMEMORY_SKILLSTATE=on (off/unset → immediate no-op, zero
// behavior change). Fail-open: any error → silent exit 0; the session is
// unaffected. Emits no hook output (non-interfering: does not block or steer).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ss = require('./lib/skillstate.js');
const { STATE_DIR } = require('./lib/state.js');

// Growth (tokens) since the last extraction that triggers the fallback.
const INTERVAL = Math.max(1000, parseInt(process.env.FOCUSMEMORY_SKILLSTATE_CHECKPOINT_INTERVAL || '50000', 10) || 50000);

/**
 * Current size of the session's tool-call JSONL (0 when absent).
 * @param {string} sessionId
 * @returns {number}
 */
function toolLogSize(sessionId) {
  try {
    return fs.statSync(path.join(STATE_DIR, `${sessionId}.jsonl`)).size;
  } catch {
    return 0;
  }
}

/**
 * Current size of the session's transcript JSONL (0 when absent).
 * @param {string} transcriptPath
 * @returns {number}
 */
function transcriptSize(transcriptPath) {
  try {
    return fs.statSync(transcriptPath).size;
  } catch {
    return 0;
  }
}

// ─── Per-session KV state (focus-llama GET /kv_state) ────────────────────
// The server exposes the session's KV accounting (logical/resident/offloaded/
// evictions/buffer). We record it into Σ as HOOK-INTERNAL bookkeeping
// (sigma.kv_state) — deliberately NOT a model-facing Σ schema field (it is not
// in SCHEMA_KEYS, so the extraction worker's mergeSigma never touches it). It
// feeds two later consumers: the injection block's `ctx:` line and the
// "evictions increased" re-injection trigger.

/**
 * Base URL of the focus-llama server hosting GET /kv_state: derived from
 * MAIN_LLM (strip the /v1/chat/completions or /v1/completions suffix) — the
 * session is served by that same server, so its per-session KV state lives
 * there. No separate config key.
 * @returns {string} base URL (no trailing slash) or '' when MAIN_LLM is unset
 */
function kvStateBaseUrl() {
  const main = (ss.env('MAIN_LLM', '') || '').trim();
  if (!main) return '';
  return main
    .replace(/\/v1\/chat\/completions$/, '')
    .replace(/\/v1\/completions$/, '')
    .replace(/\/+$/, '');
}

/**
 * Fetch the server's per-session KV state. Returns the numeric fields
 * {logical, resident, offloaded, evictions, buffer} or null (fail-open): no
 * server configured, network error, timeout, non-200 (e.g. 404 unknown
 * session), or an unparseable / empty body. Never throws.
 * @param {string} sessionId - the hook event's session_id (== server `session=`)
 * @returns {Promise<Object<string,number>|null>}
 */
async function fetchKvState(sessionId) {
  const base = kvStateBaseUrl();
  if (!base) return null;
  const url = `${base}/kv_state?session=${encodeURIComponent(sessionId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null; // 404 (unknown session) or other — fail-open
    const body = await res.json();
    if (!body || typeof body !== 'object') return null;
    const out = {};
    for (const k of ['logical', 'resident', 'offloaded', 'evictions', 'buffer']) {
      const v = Number(body[k]);
      if (Number.isFinite(v)) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null; // network error / timeout — fail-open
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop hook entry — record last_input_tokens every turn; extract when a
 * state change was logged, the context grew INTERVAL past the last
 * extraction, or a real user message arrived since the last extraction.
 * Also records the server's per-session KV state (sigma.kv_state). Spawns the
 * shared detached worker and returns immediately.
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

  // Per-session KV state from the focus-llama server (fail-open, 1.5s cap).
  // Recorded into Σ below as hook-internal bookkeeping (sigma.kv_state).
  const kvState = await fetchKvState(sessionId);

  // Token bookkeeping + trigger detection/consumption as ONE locked
  // read-modify-write: this hook and the other Stop hooks (ghost-gate,
  // turn-guard) run concurrently on the same event, and the old
  // load→modify→save sequence let same-second saves clobber each other
  // (lost update — observed 2026-09-28 disabling the ghost-gate loop guard).
  let stateChanged = false;
  let intervalHit = false;
  let newUserMsg = false;

  ss.mutateSigma(sessionId, (sigma) => {
    // Always: persist the current context size (anchor threshold input).
    sigma.last_input_tokens = inputTokens;

    // Hook-internal KV bookkeeping (separate from the model-facing Σ schema —
    // not in SCHEMA_KEYS, so the extraction worker's merge never touches it).
    // A failed/absent fetch leaves the previous snapshot untouched (fail-open).
    if (kvState) sigma.kv_state = { ...kvState, ts: new Date().toISOString() };

    // Trigger 1 — mechanical state change since the last extraction.
    const lastOffset = Number(sigma.last_extraction_log_bytes) || 0;
    stateChanged = ss.hasMutatingCallsSince(sessionId, lastOffset);

    // Trigger 2 — context growth fallback. Re-baseline when the context
    // shrank (a compaction happened since), so the interval counts fresh.
    let last = Number(sigma.last_checkpoint_tokens);
    if (!Number.isFinite(last) || last < 0) last = 0;
    if (inputTokens < last) last = inputTokens;
    intervalHit = inputTokens - last >= INTERVAL;

    // Trigger 3 — a real user message arrived since the last extraction
    // (prose-only task changes / cancellations).
    const lastTranscript = Number(sigma.last_extraction_transcript_bytes) || 0;
    newUserMsg = ss.hasNewUserMessageSince(event.transcript_path, lastTranscript);

    if (stateChanged || intervalHit || newUserMsg) {
      // Consume the triggers before spawning (persist first) so a
      // re-entrant Stop cannot re-fire: growth is re-gated by
      // last_checkpoint_tokens, state change by the tool-log byte offset,
      // user messages by the transcript byte offset.
      sigma.last_checkpoint_tokens = inputTokens;
      sigma.last_extraction_log_bytes = toolLogSize(sessionId);
      sigma.last_extraction_transcript_bytes = transcriptSize(event.transcript_path);
    }
    return sigma;
  });

  if (!stateChanged && !intervalHit && !newUserMsg) {
    ss.appendTelemetry({
      ts: Date.now(),
      session_id: sessionId,
      hook: 'stop-checkpoint-state',
      event: 'no_trigger',
      input_tokens: inputTokens,
    });
    return;
  }

  try {
    const child = spawn(
      process.execPath,
      [
        path.join(__dirname, 'precompact-extract-state.js'),
        '--worker',
        JSON.stringify({
          session_id: sessionId,
          transcript_path: event.transcript_path,
          cwd: event.cwd,
          trigger: stateChanged ? 'stop-state-change' : 'stop-checkpoint',
        }),
      ],
      { detached: true, stdio: 'ignore', env: process.env },
    );
    child.unref();
  } catch (err) {
    console.error(`[skillstate] checkpoint worker spawn failed: ${err.message}`);
  }

  ss.appendTelemetry({
    ts: Date.now(),
    session_id: sessionId,
    hook: 'stop-checkpoint-state',
    event: 'checkpoint',
    trigger: stateChanged ? 'state-change' : intervalHit ? 'context-growth' : 'user-message',
    input_tokens: inputTokens,
  });
}

main().catch(() => {}); // fail-open — a hook error must never break the session
