// FocusMemory hooks — shared config & Σ schema constants (CJS — hooks/ scope).
//
// Single source for the tunable knobs and the Σ schema constants shared by
// the SKILL.state modules (sigma-store, transcript-utils, filters, prompts,
// skillstate). Numeric knobs are env-injectable (process.env first, then
// FocusMemory/.env, then the built-in default) so a tuning change is a
// one-line .env edit, not a code change.

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE || '.';
const SIGMA_DIR = path.join(HOME, '.qwen', 'tmp', 'focus-memory', 'state');

// .env next to the hooks/ parent (FocusMemory/.env) — same file the MCP
// server loads, so hooks hit the same local services without needing the
// mcpServers env block (that only applies to the MCP process, not command hooks).
const DOTENV_PATH = path.join(__dirname, '..', '..', '.env');
let _dotenvCache = null;

/**
 * Parse FocusMemory/.env into a key/value map (no process.env override).
 * Cached per process; hooks are short-lived so staleness is a non-issue.
 * @returns {Object<string,string>}
 */
function loadDotEnv() {
  if (_dotenvCache) return _dotenvCache;
  _dotenvCache = {};
  try {
    for (const line of fs.readFileSync(DOTENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) _dotenvCache[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return _dotenvCache;
}

/**
 * Resolve a config value: process.env first, then FocusMemory/.env, then fallback.
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function env(key, fallback) {
  if (process.env[key]) return process.env[key];
  const v = loadDotEnv()[key];
  return v || fallback;
}

/**
 * Positive-integer env override: process.env first, then FocusMemory/.env;
 * falls back to `fallback` when unset, empty, or non-numeric.
 * @param {string} key - env var name
 * @param {number} fallback - built-in default
 * @returns {number} the resolved positive integer
 */
function intEnv(key, fallback) {
  const v = parseInt(env(key, ''), 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ─── Tunable knobs (env-injectable via FOCUSMEMORY_* vars) ─────────────────
const CONFIG = {
  // Transcript EOF-streaming chunk size (digestTranscript / walkTranscriptLinesFromEnd).
  TAIL_CHUNK_BYTES: intEnv('FOCUSMEMORY_TAIL_CHUNK_BYTES', 64 * 1024),
  // extractTranscriptRange read window (extended per line up to MAX_LINE_BYTES).
  RANGE_WINDOW_BYTES: intEnv('FOCUSMEMORY_RANGE_WINDOW_BYTES', 1024 * 1024),
  // Largest single transcript line the readers buffer; larger lines are skipped.
  MAX_LINE_BYTES: intEnv('FOCUSMEMORY_MAX_LINE_BYTES', 8 * 1024 * 1024),
  // Rendered-char budget: extractTranscriptTail/Delta/Range default window.
  BUDGET_CHARS: intEnv('FOCUSMEMORY_BUDGET_CHARS', 30000),
  // Active-session liveness TTL (freshestSigmaSession / recent_work fallback).
  ACTIVE_SESSION_TTL_MS: intEnv('FOCUSMEMORY_ACTIVE_SESSION_TTL_MS', 15 * 60 * 1000),
  // Cross-process history-absorb claim TTL (> the worker's 120s LLM timeout + margin).
  HIST_ABSORB_CLAIM_TTL_MS: intEnv('FOCUSMEMORY_HIST_ABSORB_CLAIM_TTL_MS', 180000),
  // compact_count bump dedup window (PostCompact + SessionStart fire together).
  COMPACT_BUMP_DEDUP_MS: intEnv('FOCUSMEMORY_COMPACT_BUMP_DEDUP_MS', 30000),
  // User-entry index LRU: max distinct transcript paths cached.
  USER_IDX_MAX_PATHS: intEnv('FOCUSMEMORY_USER_IDX_MAX_PATHS', 8),
};

/**
 * Feature gate — true only when FOCUSMEMORY_SKILLSTATE is exactly "on".
 * Resolved via env(): process env first, then FocusMemory/.env — so the
 * gate can be set either in the shell (or qwen settings env) or in .env.
 * Any other value / unset → off (hooks return immediately at the entry).
 * @returns {boolean}
 */
function skillStateEnabled() {
  return env('FOCUSMEMORY_SKILLSTATE', '') === 'on';
}

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Σ merge (paper: Σ_{t+1} = Σ_t ⊕ Δ, null deletes a key) ─────────────

// Per-key merge semantics. The content schema (2026-10-09) is three
// epistemic sections, all "current view" snapshots (replace): the extractor
// outputs the full current list or omits the key when unchanged.
//   confirmed  — facts verified by a tool call; each item cites file:line
//   hypothesis — beliefs not yet verified by a tool call
//   next       — outstanding steps, in execution order
const KEY_RULES = {
  confirmed: 'replace',
  hypothesis: 'replace',
  next: 'replace',
  // One-line current-task identity from the latest user message (2026-11-01):
  // a current-view snapshot, so it replaces rather than accumulates.
  latest_request: 'replace',
  // Active blockers (migrated from session notes' blocked status, 2026-10-15):
  // a current-view snapshot of what must NOT be retried until it clears.
  blocked: 'replace',
  // Snapshot of the offloaded (evicted) segments the model can re-load via
  // <focus> after compaction. Sourced mechanically from the kv-offload store
  // (NOT the LLM) by precompact-extract-state.js — a current-view snapshot, so
  // it replaces rather than accumulates.
  recall_pointers: 'replace',
  // Once the user revokes the original task anchor, it never un-revokes:
  // an LLM "false" (or omission) can leave the flag alone, never clear it.
  anchor_revoked: 'sticky_true',
  // B4 extension (2026-10-03): the completion release is one-way too — once
  // the original task is fully done, a later LLM "false"/omission must not
  // re-pin the stale anchor. The pin releases on completion (not only on
  // supersede), so the first turn after the task ends does not run under a
  // stale anchor (incident a39ee3d9).
  anchor_completed: 'sticky_true',
};
// Per-section item caps — keep Σ within the ~800-token injection budget.
const SECTION_CAPS = { confirmed: 10, hypothesis: 5, next: 5, blocked: 3 };
const MAX_LIST_ITEMS = 50; // cap cumulative lists so Σ stays injection-sized

// ─── History layer (Σ-strip stage 2, 2026-11-05) ─────────────────────────
// A second, CUMULATIVE layer of Σ: past-tense records of work that has LEFT
// the context (removed by strip stage 2, or evicted at compaction). Unlike the
// work-state layer (confirmed/hypothesis/next/blocked — current-view snapshots
// that REPLACE, written only by the PreCompact path), history is a UNION that
// only grows (per-key cap drops the OLDEST items). The strip extractor may
// write ONLY these keys (mergeStripPatch whitelist) — it must never touch the
// work-state or anchor keys, so a stale old-region snapshot can never overwrite
// the current view (plan §3: the 2026-11-01 stale-anchor contamination rule).
//   hist_done        — "<what was done> — file:line or command/result"
//   hist_dead_ends   — "<tried but did not work> — <why>"
//   hist_decisions   — "<decision> — <why / rejected alternative>"
//   hist_requests    — "<one-line earlier user request>"
//   hist_files_read / hist_files_edited — [path] (rule-based; exact-match dedup)
// hist_last_bytes is the transcript byte offset up to which history has been
// extracted (monotonic — a failed extraction leaves it unmoved so the next
// refresh re-reads the same region, plan §5.3 rule 1).
const HIST_KEYS = [
  'hist_done', 'hist_dead_ends', 'hist_decisions', 'hist_requests',
  'hist_files_read', 'hist_files_edited',
];
const HIST_CAPS = {
  hist_done: 40,
  hist_dead_ends: 15,
  hist_decisions: 15,
  hist_requests: 10,
  hist_files_read: 30,
  hist_files_edited: 30,
};
// Item 15: keys whose items are file paths — exact-match dedup only.
// normItem splits path separators into tokens, so distinct paths sharing a
// directory prefix (state.js vs state/extra.js) reach Jaccard >= 0.8 and a
// similarity gate would silently drop one of the files.
const EXACT_DEDUP_KEYS = new Set(['hist_files_read', 'hist_files_edited']);
// The strip extractor emits SHORT keys; mergeStripPatch maps them onto the
// hist_* storage keys. Both forms appear in patches/Σ, so the ref filters scan
// both (a history item may cite a file:line, a todos path, or a state file).
const HIST_PATCH_KEYS = ['done', 'dead_ends', 'decisions', 'requests'];
const FILTERABLE_KEYS = [
  'confirmed', 'hypothesis', 'next', 'blocked',
  'done', 'dead_ends', 'decisions',
  'hist_done', 'hist_dead_ends', 'hist_decisions',
];

// ─── History consolidation (S7, plan §4.3) ────────────────────────────────
// At compaction the layer is compressed in ONE LLM pass: related older items
// are merged into milestone lines within the per-key caps (compress instead of
// letting the cap DROP the oldest). Only the TEXT keys are rewritten — the
// rule-based file lists (hist_files_read/edited) are already compact and are
// left to the cap-drop.
const CONSOLIDATE_KEYS = ['hist_done', 'hist_dead_ends', 'hist_decisions', 'hist_requests'];

const SCHEMA_KEYS = ['confirmed', 'hypothesis', 'next', 'blocked', 'anchor_revoked', 'anchor_completed', 'latest_request', 'done', 'dead_ends', 'decisions', 'requests'];

module.exports = {
  SIGMA_DIR,
  SESSION_UUID_RE,
  CONFIG,
  env,
  skillStateEnabled,
  KEY_RULES,
  SECTION_CAPS,
  MAX_LIST_ITEMS,
  HIST_KEYS,
  HIST_CAPS,
  EXACT_DEDUP_KEYS,
  HIST_PATCH_KEYS,
  FILTERABLE_KEYS,
  CONSOLIDATE_KEYS,
  SCHEMA_KEYS,
};
