// SKILL.state shared helpers for FocusMemory hooks (CJS — hooks/ scope).
//
// Implements the Σ (structured execution state) design from the SKILL.state
// paper (arXiv:2608.26263): instead of letting native compaction reduce a
// long session to a prose summary, we extract a structured state patch from
// the pre-compaction transcript, merge it into a per-session Σ file, and
// re-inject Σ after compaction so the model conditions on explicit state
// rather than reconstructed history.
//
// Everything here is fail-open by design: a hook must never block or break
// the native compaction flow. Any error → the hook exits silently and qwen
// proceeds with its normal behavior.
//
//
// Module layout (SRP split):
//   config.js           — env plumbing, tunable CONFIG, Σ schema constants
//   sigma-store.js      — per-session Σ file I/O (locked read/write/mutate)
//   transcript-utils.js — bounded transcript JSONL readers + offset mapping
//   filters.js          — mechanical pre-merge gates (evidence/ghost/foreign)
//   prompts.js          — LLM prompt builders + transport
//   this file           — Σ rendering + merge + patch parsing + similarity gates
// The hook entry files import this module; every original export is
// re-exported here unchanged.

const { appendTelemetry } = require('./state.js');
const {
  SIGMA_DIR, env, skillStateEnabled,
  KEY_RULES, SECTION_CAPS, MAX_LIST_ITEMS,
  HIST_KEYS, HIST_CAPS, EXACT_DEDUP_KEYS, HIST_PATCH_KEYS, SCHEMA_KEYS,
} = require('./config.js');
const sigmaStore = require('./sigma-store.js');
const transcriptUtils = require('./transcript-utils.js');
const filters = require('./filters.js');
const prompts = require('./prompts.js');

// ─── Σ render (presentation-time blocks) ─────────────────────────────────

/**
 * Render a compact "where are we" anchor from Σ. One line, capped — the
 * anchor must cost a negligible fraction of the context it is meant to
 * protect.
 * @param {object} sigma
 * @param {object} [opts]
 * @param {boolean} [opts.record=false] - true: label task/step as a RECORD of
 *   the previous turn, not the current task. Required by the per-turn
 *   UserPromptSubmit anchor: that state is one turn behind by construction,
 *   and the imperative "task:" label made the model resume a
 *   completed/superseded task instead of answering the user's new message
 *   (2026-10-02 incident: mid-investigation jump back to a finished
 *   re-apply task). false (default): directive framing, for callers that
 *   resume the work.
 * @returns {string} compact anchor text (empty string when Σ has no content)
 */
function renderAnchor(sigma, opts = {}) {
  if (!sigma || typeof sigma !== 'object') return '';
  const record = !!opts.record;
  const parts = [];
  if (sigma.anchor_revoked === true) parts.push('original-task-anchor: REVOKED by user');
  if (sigma.anchor_completed === true) parts.push('original-task-anchor: COMPLETED');

  // Current-task identity (2026-11-01): the latest user request as the
  // extractor restated it — re-presents WHAT the work is mid-turn, so an
  // evicted old task's framing cannot re-latch the model onto the wrong
  // request after its messages leave the KV.
  if (typeof sigma.latest_request === 'string' && sigma.latest_request.trim()) {
    parts.push(`current-task (latest user request — defines the work): ${sigma.latest_request}`);
  }

  // 2026-10-09 three-section schema: confirmed (verified, file:line) /
  // hypothesis (unverified) / next (outstanding steps). next first — it is
  // what the next turn acts on; confirmed second — the verified ground the
  // action relies on; hypothesis last — the least trustworthy.
  const strList = (k) => (Array.isArray(sigma[k]) ? sigma[k].filter((x) => typeof x === 'string' && x.trim()) : []);
  const next = strList('next');
  const confirmed = strList('confirmed');
  const hypothesis = strList('hypothesis');
  // blocked first — constraints (DO NOT RETRY) must precede the actions they
  // constrain; migrated from session notes' blocked status (2026-10-15).
  const blocked = strList('blocked');
  if (blocked.length) parts.push(`blocked (DO NOT RETRY): ${blocked.slice(0, 3).join('; ')}`);
  if (next.length) parts.push(`next: ${next.slice(0, 5).join('; ')}`);
  if (confirmed.length) parts.push(`confirmed: ${confirmed.slice(0, 10).join('; ')}`);
  if (hypothesis.length) parts.push(`hypothesis (UNVERIFIED — re-check before acting): ${hypothesis.slice(0, 5).join('; ')}`);

  // Legacy fallback — pre-2026-10-09 Σ files still carry the flat keys;
  // render them until the next extraction overwrites them with sections.
  if (sigma.task_summary) parts.push(record
    ? `previous-turn task (record — NOT the current task): ${sigma.task_summary}`
    : `task: ${sigma.task_summary}`);
  if (sigma.current_step) parts.push(record
    ? `previous-turn step (record — NOT a directive): ${sigma.current_step}`
    : `step: ${sigma.current_step}`);
  if (Array.isArray(sigma.pending_checks) && sigma.pending_checks.length) {
    parts.push(`pending: ${sigma.pending_checks.slice(0, 5).join('; ')}`);
  }
  if (Array.isArray(sigma.files_touched) && sigma.files_touched.length) {
    parts.push(`files: ${sigma.files_touched.slice(-5).join(', ')}`);
  }
  if (sigma.tests_status && typeof sigma.tests_status === 'object' && !Array.isArray(sigma.tests_status)) {
    const failing = Object.entries(sigma.tests_status)
      .filter(([, v]) => v === 'fail')
      .map(([k]) => k);
    if (failing.length) parts.push(`failing: ${failing.join(', ')}`);
  }

  if (Array.isArray(sigma.recall_pointers) && sigma.recall_pointers.length) {
    const n = sigma.recall_pointers.length;
    const last = sigma.recall_pointers[n - 1];
    const hint = last && last.hint ? ` (most recent: ${last.hint})` : '';
    parts.push(
      `offloaded: ${n} segment(s) from before compaction left the context. ` +
      `Their chunk numbers are in the "offloaded" chunk list of the attention scaffold ` +
      `(not a session note, not a tool). To re-read one, emit <focus magic_chunks="N"> ` +
      `on its own line with that number${hint}`
    );
  }
  return parts.join(' | ');
}

/**
 * Render the post-compaction reference block from Σ (2026-11-04 Phase 2).
 *
 * Unlike renderAnchor (a one-line directive "where are we"), this renders
 * the structured state as a PAST-TENSE reference: the session was just
 * natively compacted and the SessionStart(source=compact) hook re-injects
 * this block once. It must let the model recover "what was being done and
 * where" without re-latching it as the current task:
 *   - `next` is included but STALE-FRAMED — the most directive field, and
 *     this text persists for the whole session, so it renders as "pending at
 *     compaction time (may be stale — cross-check against confirmed before
 *     acting)", never a live directive (the 2026-10-15 / 2026-10-20 /
 *     2026-11-01 incidents were re-injected state text read as live
 *     instructions — a completed task's steps re-run, a stale anchor
 *     resumed). `latest_request` stays EXCLUDED — the current task is
 *     defined by the latest user message, which the hook injects verbatim
 *     right after this block.
 *   - every label is past-tense ("at compaction time"), never "current
 *     task" / "do next".
 *   - protective constraints (blocked / failing tests) and the anchor
 *     flags stay: they guard against re-attempts, they do not direct work.
 * @param {object} sigma
 * @returns {string} the reference body ('' when Σ has no renderable content)
 */
function renderCompactSigma(sigma) {
  if (!sigma || typeof sigma !== 'object') return '';
  const strList = (k) => (Array.isArray(sigma[k]) ? sigma[k].filter((x) => typeof x === 'string' && x.trim()) : []);
  const lines = [];

  if (sigma.anchor_revoked === true) lines.push('- original task: REVOKED by the user before compaction');
  if (sigma.anchor_completed === true) lines.push('- original task: COMPLETED before compaction');

  if (typeof sigma.task_summary === 'string' && sigma.task_summary.trim()) {
    lines.push(`- task at compaction time: ${sigma.task_summary.trim()}`);
  }

  const confirmed = strList('confirmed');
  if (confirmed.length) {
    lines.push(`- verified before compaction (file:line references as recorded):\n${confirmed.slice(0, 10).map((x) => `    - ${x}`).join('\n')}`);
  }

  const next = strList('next');
  if (next.length) {
    lines.push(`- pending at compaction time (may be STALE — cross-check against confirmed before acting):\n${next.slice(0, 5).map((x) => `    - ${x}`).join('\n')}`);
  }

  const hypothesis = strList('hypothesis');
  if (hypothesis.length) {
    lines.push(`- believed but UNVERIFIED at compaction time (re-check before acting):\n${hypothesis.slice(0, 5).map((x) => `    - ${x}`).join('\n')}`);
  }

  const blocked = strList('blocked');
  if (blocked.length) {
    lines.push(`- blocked (DO NOT RETRY) at compaction time:\n${blocked.slice(0, 3).map((x) => `    - ${x}`).join('\n')}`);
  }

  if (sigma.tests_status && typeof sigma.tests_status === 'object' && !Array.isArray(sigma.tests_status)) {
    const failing = Object.entries(sigma.tests_status).filter(([, v]) => v === 'fail').map(([k]) => k);
    if (failing.length) lines.push(`- failing tests at compaction time: ${failing.join(', ')}`);
  }

  if (Array.isArray(sigma.recall_pointers) && sigma.recall_pointers.length) {
    const n = sigma.recall_pointers.length;
    const last = sigma.recall_pointers[n - 1];
    const hint = last && last.hint ? ` (most recent: ${last.hint})` : '';
    lines.push(
      `- offloaded: ${n} segment(s) left the context before compaction. ` +
      `To re-read one, emit <focus magic_chunks="N"> on its own line with the chunk number ` +
      `from the "offloaded" chunk list of the attention scaffold${hint}`
    );
  }

  // History layer (Σ-strip stage 2): cumulative past-tense records of work that
  // left the context. Compact here (renderStripSigma is the full renderer);
  // included so a post-compaction anchor also carries the removed-work memory.
  const histDone = strList('hist_done');
  const histDead = strList('hist_dead_ends');
  const histDec = strList('hist_decisions');
  const histReq = strList('hist_requests');
  if (histDone.length || histDead.length || histDec.length || histReq.length) {
    lines.push('- earlier work removed from context (past tense; file refs may be stale):');
    if (histDone.length) lines.push(histDone.slice(-5).map((x) => `    - done: ${x}`).join('\n'));
    if (histDead.length) lines.push(histDead.slice(-3).map((x) => `    - dead end (do not retry): ${x}`).join('\n'));
    if (histDec.length) lines.push(histDec.slice(-3).map((x) => `    - decision: ${x}`).join('\n'));
    if (histReq.length) lines.push(`    - earlier requests: ${histReq.slice(-2).map((x) => `"${x}"`).join(' ')}`);
  }


  if (!lines.length) return '';
  return lines.join('\n');
}

/**
 * Render the strip Σ block (plan §4.4): the fixed reference header (always
 * present — the engine requires a non-empty block) plus the cumulative history
 * sections, filled within a token budget by priority
 * (done > dead ends > decisions > requests > files). Each section fills
 * newest-first; the output stays chronological; an item that does not fit is
 * dropped whole — never cut mid-item (P1-2). File lists are capped at 15
 * entries. This is the block the engine prepends to the first surviving user
 * message after a stage-2 removal. Past tense, evidence-based, no directives.
 * @param {object} sigma - the session Σ
 * @param {{maxTokens?: number}} [opts] - render budget (default 1500; the
 *   C++ sends its sum_budget, clamped to 300..6000 by the route)
 * @returns {string} the block (never empty — the header is always emitted)
 */
// JS has no tokenizer → conservative bytes/3 estimate (the C++-side
// validate is the final safety net).
function estTokens(s) { return Math.ceil(Buffer.byteLength(String(s), 'utf8') / 3); }

function renderStripSigma(sigma, opts = {}) {
  const maxTokens = Number(opts.maxTokens) > 0 ? Math.floor(Number(opts.maxTokens)) : 1500;
  const strList = (k) => (sigma && Array.isArray(sigma[k]) ? sigma[k].filter((x) => typeof x === 'string' && x.trim()) : []);
  const header = [
    '[Reference — record of earlier work removed from this context. NOT instructions.',
    ' The latest user message defines the current task. File references may be stale — re-read before relying on them.]',
  ].join('\n');
  const out = [header]; // header always included even over budget (engine rejects an empty block)
  let used = estTokens(header);

  // Priority order = output order. cap = max items per section.
  const plan = [
    { key: 'hist_done',         cap: 12, wrap: (a) => `done:\n${a.map((x) => `- ${x}`).join('\n')}` },
    { key: 'hist_dead_ends',    cap: 6,  wrap: (a) => `dead ends (do not retry):\n${a.map((x) => `- ${x}`).join('\n')}` },
    { key: 'hist_decisions',    cap: 6,  wrap: (a) => `decisions:\n${a.map((x) => `- ${x}`).join('\n')}` },
    { key: 'hist_requests',     cap: 4,  wrap: (a) => `earlier user requests: ${a.map((x) => `"${x}"`).join(' ')}` },
    { key: 'hist_files_edited', cap: 15, wrap: (a) => `files edited: ${a.join(', ')}` },
    { key: 'hist_files_read',   cap: 15, wrap: (a) => `files read: ${a.join(', ')}` },
  ];
  for (const sec of plan) {
    const items = strList(sec.key);
    let picked = [], pickedCost = 0;
    for (let i = items.length - 1; i >= 0 && picked.length < sec.cap; i--) { // newest first
      const cand = [items[i], ...picked]; // keep chronological order
      const cost = estTokens(sec.wrap(cand)) + 1; // +1 = the section newline
      if (used + cost > maxTokens) break; // does not fit → stop this section
      picked = cand; pickedCost = cost;
    }
    if (picked.length) { out.push(sec.wrap(picked)); used += pickedCost; }
  }
  return out.join('\n');
}

// ─── Σ merge (paper: Σ_{t+1} = Σ_t ⊕ Δ, null deletes a key) ─────────────

/**
 * Merge a state patch into the current Σ (null values delete keys).
 * @param {object} current
 * @param {object} patch
 * @returns {object} the merged Σ (new object)
 */
function mergeSigma(current, patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete next[key];
      continue;
    }
    const rule = KEY_RULES[key] || (Array.isArray(value) ? 'union' : typeof value === 'object' ? 'merge' : 'replace');
    if (rule === 'union' && Array.isArray(value)) {
      const base = Array.isArray(next[key]) ? next[key] : [];
      const merged = [...base];
      for (const item of value) {
        if (!merged.includes(item)) merged.push(item);
      }
      next[key] = merged.slice(-MAX_LIST_ITEMS);
    } else if (rule === 'merge' && typeof value === 'object') {
      const base = (typeof next[key] === 'object' && next[key] !== null && !Array.isArray(next[key])) ? next[key] : {};
      const merged = { ...base };
      for (const [k, v] of Object.entries(value)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      next[key] = merged;
    } else if (rule === 'sticky_true') {
      next[key] = next[key] === true || value === true;
    } else {
      // Section snapshots: keep only non-empty strings, enforce the
      // per-section item cap (the ~800-token Σ budget).
      if (Array.isArray(value) && SECTION_CAPS[key] != null) {
        next[key] = value.filter((x) => typeof x === 'string' && x.trim()).slice(0, SECTION_CAPS[key]);
      } else {
        next[key] = value;
      }
    }
  }
  // 2026-10-12: on the transition to completed/revoked, clear the
  // outstanding-work fields (next, hypothesis, blocked) unless the extractor
  // provided fresh ones. A completed task whose stale next/hypothesis
  // lingers gets re-injected as the next turn's anchor and the model
  // resumes/re-verifies finished work (recurring 2026-10-02 incident:
  // the render-side record frame covered only the legacy flat keys, so
  // the 3-section `next` still read as a directive after COMPLETED).
  // Fires only on the transition (not on sticky re-output), so a later
  // new task's steps are never over-suppressed. confirmed is kept — it
  // is historical ground, not outstanding work.
  const doneTransition =
    (patch.anchor_completed === true && current.anchor_completed !== true) ||
    (patch.anchor_revoked === true && current.anchor_revoked !== true);
  if (doneTransition) {
    for (const k of ['next', 'hypothesis', 'blocked']) {
      const provided = Array.isArray(patch[k]) && patch[k].some((x) => typeof x === 'string' && x.trim());
      if (!provided) next[k] = [];
    }
  }
  return next;
}

// ─── Strip history merge (S2, plan §4.2/§4.6) ─────────────────────────────
// The strip extractor emits SHORT keys (done/dead_ends/decisions/requests);
// mergeStripPatch maps them onto the hist_* storage keys and UNIONs them into
// the existing history with similarity dedup + per-key cap (drop OLDEST). It
// touches ONLY hist_* keys — the work-state/anchor keys pass through untouched,
// so a stale old-region snapshot can never overwrite the current view.
/**
 * Union a strip-extraction patch into a Σ's history layer.
 * @param {object} sigma - the current Σ
 * @param {object} patch - strip patch (short keys done/dead_ends/decisions/requests, or hist_* keys)
 * @returns {object} the next Σ (a new object; only hist_* keys change)
 */
function mergeStripPatch(sigma, patch) {
  const next = { ...sigma };
  if (!patch || typeof patch !== 'object') return next;
  const incoming = {};
  for (const shortKey of HIST_PATCH_KEYS) {
    if (Array.isArray(patch[shortKey])) {
      const hk = 'hist_' + shortKey;
      incoming[hk] = (incoming[hk] || []).concat(patch[shortKey]);
    }
  }
  for (const hk of HIST_KEYS) {
    if (Array.isArray(patch[hk])) incoming[hk] = (incoming[hk] || []).concat(patch[hk]);
  }
  for (const hk of Object.keys(incoming)) {
    const cap = HIST_CAPS[hk];
    const exactOnly = EXACT_DEDUP_KEYS.has(hk);
    const base = (Array.isArray(next[hk]) ? next[hk] : []).filter((x) => typeof x === 'string' && x.trim());
    for (const item of incoming[hk]) {
      if (typeof item !== 'string' || !item.trim()) continue;
      let dup = false;
      for (const existing of base) {
        if (existing === item || (!exactOnly && itemSimilarity(existing, item) >= 0.8)) { dup = true; break; }
      }
      if (!dup) base.push(item);
    }
    next[hk] = cap != null ? base.slice(-cap) : base; // keep the most recent
  }
  return next;
}

// ─── Patch parsing + similarity gates ───────────────────────────────────

/**
 * Unwrap a {"state_patch": {...}} envelope if present.
 * @param {object} p
 * @returns {object}
 */
function unwrapPatch(p) {
  if (p && typeof p === 'object' && p.state_patch && typeof p.state_patch === 'object') return p.state_patch;
  return p;
}

/**
 * Extract the state-patch JSON object from LLM output. Tolerates markdown
 * fences, thinking preambles, and trailing commentary. Scans all balanced
 * top-level brace candidates (string/escape aware) and prefers ones
 * containing schema keys, trying the LAST candidate first (the final answer
 * usually comes after any mid-text examples).
 * @param {string} text
 * @returns {object|null}
 */
function extractJsonPatch(text) {
  if (typeof text !== 'string' || !text) return null; // defensive: never throw on non-string
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidate = fence[1].trim();

  const balanced = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        balanced.push(candidate.slice(start, i + 1));
        start = -1;
      }
    }
  }

  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const isObject = (p) => p !== null && typeof p === 'object' && !Array.isArray(p);
  const hasSchemaKey = (p) => isObject(p) && (p.state_patch !== undefined || SCHEMA_KEYS.some((k) => k in p));

  let p = tryParse(candidate);
  if (hasSchemaKey(p)) return unwrapPatch(p);
  // Final answer first: scan candidates right-to-left
  for (let i = balanced.length - 1; i >= 0; i--) {
    p = tryParse(balanced[i]);
    if (hasSchemaKey(p)) return unwrapPatch(p);
  }
  for (let i = balanced.length - 1; i >= 0; i--) {
    p = tryParse(balanced[i]);
    if (isObject(p)) return p;
  }
  return null;
}

/**
 * Emit a hook JSON output on stdout.
 * @param {object} hookSpecificOutput
 */
function emitHookOutput(hookSpecificOutput) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

/**
 * Normalize a next-item for overlap comparison (lowercase, word chars only —
 * keeps CJK so Korean steps compare correctly).
 * @param {string} s
 * @returns {string}
 */
function normItem(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9가-힣]+/g, ' ').trim();
}

/**
 * Word-token Jaccard similarity between two next-items.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
function itemSimilarity(a, b) {
  const ta = new Set(normItem(a).split(' ').filter(Boolean));
  const tb = new Set(normItem(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

/**
 * Fraction of incoming next-items that resemble a baseline item (the
 * re-derivation signal). >= 0.5 means the incoming list is mostly the SAME
 * task's steps (a stale re-derivation); < 0.5 means it is a genuinely new task.
 * @param {string[]} incoming
 * @param {string[]} baseline
 * @returns {number} 0..1 (0 when either list is empty)
 */
function nextOverlapRatio(incoming, baseline) {
  const inc = (incoming || []).filter((x) => typeof x === 'string' && x.trim());
  const base = (baseline || []).filter((x) => typeof x === 'string' && x.trim());
  if (!inc.length || !base.length) return 0;
  let matched = 0;
  for (const item of inc) {
    let best = 0;
    for (const b of base) {
      const sim = itemSimilarity(item, b);
      if (sim > best) best = sim;
    }
    if (best >= 0.4) matched++;
  }
  return matched / inc.length;
}

/**
 * Anchor-done gate action for an incoming `next` patch (2026-10-20 stale-anchor
 * fix). The 2026-10-15 gate only ever STRIPPED next (preserving the current
 * list), which — combined with sticky anchor_completed and no reset-arming in
 * evict-extract — FROZE a stale next indefinitely. This adds a RELEASE action:
 *   'none'    — anchor not done, or no next in the patch: merge normally.
 *   'strip'   — anchor done and the incoming next re-derives the completed
 *               task's steps (high overlap with the baseline): omit next from
 *               the patch so the current list is preserved (the 2026-10-15
 *               stale-anchor protection).
 *   'release' — anchor done but the incoming next is a genuinely NEW task
 *               (low overlap with the baseline, or no baseline): the
 *               completed/revoked anchor is stale (premature flip or a
 *               superseded task). Release it so the new task runs under a clean
 *               anchor instead of a "COMPLETED + new work" framing.
 * @param {object} cur - the current Σ (before merge)
 * @param {object} patch - the incoming patch
 * @returns {{action: 'none'|'strip'|'release'}}
 */
function anchorDoneGateAction(cur, patch) {
  const anchorDone = cur.anchor_completed === true || cur.anchor_revoked === true;
  if (!anchorDone || !Object.prototype.hasOwnProperty.call(patch, 'next')) return { action: 'none' };
  const incoming = (Array.isArray(patch.next) ? patch.next : []).filter((x) => typeof x === 'string' && x.trim());
  if (!incoming.length) return { action: 'none' };
  const baseline = (Array.isArray(cur.anchor_done_next) && cur.anchor_done_next.length)
    ? cur.anchor_done_next
    : (Array.isArray(cur.next) ? cur.next : []);
  if (!baseline.length) return { action: 'release' }; // no completed-task baseline → new task
  return { action: nextOverlapRatio(incoming, baseline) >= 0.5 ? 'strip' : 'release' };
}

module.exports = {
  // config.js
  SIGMA_DIR,
  env,
  skillStateEnabled,
  SCHEMA_KEYS,
  // sigma-store.js
  sigmaFile: sigmaStore.sigmaFile,
  loadSigma: sigmaStore.loadSigma,
  saveSigma: sigmaStore.saveSigma,
  mutateSigma: sigmaStore.mutateSigma,
  claimHistAbsorb: sigmaStore.claimHistAbsorb,
  releaseHistAbsorb: sigmaStore.releaseHistAbsorb,
  freshestSigmaSession: sigmaStore.freshestSigmaSession,
  deriveTranscriptPath: sigmaStore.deriveTranscriptPath,
  ensureTranscriptPath: sigmaStore.ensureTranscriptPath,
  cwdFromTranscriptPath: sigmaStore.cwdFromTranscriptPath,
  bumpCompactCount: sigmaStore.bumpCompactCount,
  sweepSigma: sigmaStore.sweepSigma,
  // transcript-utils.js
  digestTranscript: transcriptUtils.digestTranscript,
  extractTranscriptTail: transcriptUtils.extractTranscriptTail,
  extractTranscriptDelta: transcriptUtils.extractTranscriptDelta,
  extractTranscriptRange: transcriptUtils.extractTranscriptRange,
  ruleHistFromEntries: transcriptUtils.ruleHistFromEntries,
  transcriptByteOffsetForMessageIndex: transcriptUtils.transcriptByteOffsetForMessageIndex,
  resolveAbsorbTo: transcriptUtils.resolveAbsorbTo,
  anchorNorm: transcriptUtils.anchorNorm,
  findAnchorOffset: transcriptUtils.findAnchorOffset,
  hashBlock: transcriptUtils.hashBlock,
  extractLastUserMessage: transcriptUtils.extractLastUserMessage,
  // filters.js
  gateStripPatch: filters.gateStripPatch,
  filterGhostRefs: filters.filterGhostRefs,
  foreignSessionRefs: filters.foreignSessionRefs,
  filterForeignSessionRefs: filters.filterForeignSessionRefs,
  scrubSigmaForeignRefs: filters.scrubSigmaForeignRefs,
  completionSignal: filters.completionSignal,
  // prompts.js
  buildExtractionPrompt: prompts.buildExtractionPrompt,
  buildStripExtractionPrompt: prompts.buildStripExtractionPrompt,
  buildConsolidationPrompt: prompts.buildConsolidationPrompt,
  historyNeedsConsolidation: prompts.historyNeedsConsolidation,
  sanitizeConsolidatedPatch: prompts.sanitizeConsolidatedPatch,
  callSummaryLLM: prompts.callSummaryLLM,
  fetchOpenTodoChains: prompts.fetchOpenTodoChains,
  // this file (Σ core: render / merge / parse / similarity)
  renderAnchor,
  renderCompactSigma,
  renderStripSigma,
  mergeSigma,
  mergeStripPatch,
  extractJsonPatch,
  emitHookOutput,
  anchorDoneGateAction,
  nextOverlapRatio,
  // state.js passthrough
  appendTelemetry,
};
