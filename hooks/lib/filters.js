// SKILL.state mechanical pre-merge gates (CJS — hooks/ scope).
//
// The hard, deterministic checks that run on every extracted / strip patch
// before it merges into Σ: the evidence gates (file-path / command-result
// tokens), the imperative gate, the ghost-todos filter, the foreign-session
// state filter, and the completion-signal patterns. The extraction prompts
// are the soft layer; these are the backstop.

const fs = require('fs');
const path = require('path');
const { FILTERABLE_KEYS, HIST_PATCH_KEYS } = require('./config.js');

// Mechanical pre-merge gates for strip patches (plan §4.2). The extraction
// prompt is the soft layer; these are the hard checks that run on every patch
// before mergeStripPatch. (1) `done` items must cite evidence (a file path or
// a command/result marker) — an unevidenced "done" is a confabulation risk.
// (2) the shared ref filters (ghost todos + foreign state) drop items that
// cite non-existent dated todos files or OTHER sessions' state files.
// (3) imperative items are directives, not records — a "next: do X" transcribed
// from the removed region would re-inject as a task and re-latch the model.
// Extension whitelist for file-path evidence (review item 13). The old
// /\S+\.\w{1,10}/ matched "v2.1", "e.g", "Node.js" — not files. Only real
// source/doc/config extensions count as path evidence.
const EVIDENCE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'php', 'cpp', 'cc', 'cxx', 'c', 'h', 'hh', 'hpp',
  'cs', 'go', 'rs', 'rb', 'java', 'kt', 'swift', 'sh', 'bash', 'zsh', 'ps1', 'pl', 'lua', 'r',
  'sql', 'json', 'jsonc', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'lock',
  'md', 'markdown', 'rst', 'txt', 'csv', 'tsv', 'log', 'diff', 'patch',
  'xml', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte',
]);
/**
 * Whether the text cites a path-shaped file token: it ends in a whitelisted
 * extension (case-insensitive, optional :line) AND either contains a '/'
 * directory separator or is a bare filename whose name starts with a lowercase
 * letter/digit/underscore — the latter rejects CamelCase product names like
 * "Node.js" while keeping "index.js".
 * @param {string} text
 * @returns {boolean} true when a real file-path evidence token is present
 */
function hasFileEvidence(text) {
  const re = /[\w.@~-]+(?:\/[\w.@~-]+)*\.[A-Za-z0-9]{1,10}(?::\d+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const noLine = m[0].replace(/:\d+$/, '');
    const dot = noLine.lastIndexOf('.');
    const ext = noLine.slice(dot + 1).toLowerCase();
    if (!EVIDENCE_EXTENSIONS.has(ext)) continue;
    const base = noLine.slice(0, dot).split('/').pop();
    if (noLine.includes('/') || /^[a-z0-9_]/.test(base)) return true;
  }
  return false;
}
// Command/result evidence (review item 13): an exit code, a test/build count, or
// a standalone ALL-CAPS result marker. The old gate matched any lowercase
// "ok"/"error"/"pass" in prose ("Fixed the error handling") — not a result.
const RESULT_CODE_RE = /(exit\s*\d+|\d+\s+(?:passed|failed|errors?|tests?|warnings?)\b)/i;
const RESULT_MARKER_RE = /(?:^|[\s→:=(])(PASS(?:ED)?|FAIL(?:ED)?|OK|ERROR|TIMEOUT)(?=[\s.):,;=→)]|$)/;
/**
 * Whether the text cites a command/result marker (exit code, test/build count,
 * or a standalone all-caps PASS/FAIL/OK/ERROR/TIMEOUT).
 * @param {string} text
 * @returns {boolean} true when a real command/result evidence token is present
 */
function hasResultEvidence(text) {
  return RESULT_CODE_RE.test(text) || RESULT_MARKER_RE.test(text);
}
// Boundary-anchored: past-tense records ("Fixed x in a.js:3", "Updated the
// pool") must survive — only bare-verb directives ("fix the bug", "next: do X")
// are dropped. "do not retry" is a protective record, kept.
const IMPERATIVE_RE = /^\s*(next|todo|please|run|do|add|create|update|delete|fix|implement|refactor|추가해|생성해|수정해|삭제해|구현해|해라|하세요|해주세요|해줘)(?=[\s:.]|$)(?!\s+not\b)/i;
// Review item 14: Korean imperatives CLOSE the sentence ("서버 설정을
// 수정해줘"), so the start-anchor above never catches them. Past records end
// in -했다/-하였다, not these imperative endings.
const IMPERATIVE_KO_END_RE = /(해줘|해라|하세요|해주세요|하자)[.!]?$/;

/**
 * Apply the mechanical gates to a strip patch (mutated in place).
 * @param {object} patch - the strip patch (short keys)
 * @param {string} sessionId - the current session id (foreign-ref gate)
 * @param {string} cwd - session working directory (ghost-todo gate base)
 * @returns {{patch: object, removed: Array<object>}} the (mutated) patch + removed items for telemetry
 */
function gateStripPatch(patch, sessionId, cwd, opts = {}) {
  const removed = [];
  if (!patch || typeof patch !== 'object') return { patch, removed, total: 0 };
  // P1-1: total input items across the gated short keys (for the drop-rate log)
  let total = 0;
  for (const k of HIST_PATCH_KEYS) if (Array.isArray(patch[k])) total += patch[k].length;
  // P1-3: LLM patches must use the SHORT keys (done/dead_ends/decisions/
  // requests) so the gates below apply to every item. Direct hist_* keys
  // would bypass them (mergeStripPatch accepts both forms). The rule path
  // (skipEvidence) is exempt — it emits hist_files_read/edited, which are
  // structurally grounded, not LLM output.
  if (!opts.skipEvidence) {
    for (const k of Object.keys(patch)) {
      if (k.startsWith('hist_')) {
        removed.push({ key: k, item: null, reason: 'hist-direct-key' });
        delete patch[k];
      }
    }
  }
  // The evidence gate rejects "done" claims with no file/result token — right
  // for LLM output (confabulation guard). Rule-based patches are structurally
  // grounded (a real tool call), so skipEvidence lets them through.
  if (Array.isArray(patch.done) && !opts.skipEvidence) {
    patch.done = patch.done.filter((item) => {
      if (typeof item !== 'string') return true;
      const hasEvidence = hasFileEvidence(item) || hasResultEvidence(item);
      if (!hasEvidence) removed.push({ key: 'done', item, reason: 'no-evidence' });
      return hasEvidence;
    });
    if (patch.done.length === 0) delete patch.done;
  }
  const g = filterGhostRefs(patch, cwd);
  for (const r of g.removed) removed.push({ ...r, reason: 'ghost-ref' });
  const f = filterForeignSessionRefs(patch, sessionId);
  for (const r of f.removed) removed.push({ ...r, reason: 'foreign-ref' });
  for (const key of HIST_PATCH_KEYS) {
    const arr = patch[key];
    if (!Array.isArray(arr)) continue;
    // P0-2: user requests are essentially imperative ("fix the login bug"),
    // so the imperative gate would drop nearly all of them. Exclude
    // `requests` from the check and force the "asked:" prefix (the rule path
    // already adds it; the LLM path may not) so they survive as records.
    if (key === 'requests') {
      patch[key] = arr.map((item) => {
        if (typeof item !== 'string') return item;
        const t = item.trim();
        if (!t) return item;
        return t.startsWith('asked:') ? t : `asked: ${t}`;
      });
      continue;
    }
    patch[key] = arr.filter((item) => {
      if (typeof item !== 'string') return true;
      // Item 14: a past record that leads with a verb ("Run ./test → 2
      // failed") survives via result evidence; bare directives are dropped.
      if ((IMPERATIVE_RE.test(item) || IMPERATIVE_KO_END_RE.test(item)) && !hasResultEvidence(item)) {
        removed.push({ key, item, reason: 'imperative' }); return false;
      }
      return true;
    });
    if (patch[key].length === 0) delete patch[key];
  }
  return { patch, removed, total };
}

// Ghost-reference filter (2026-09-26 context-confusion incident): the
// extractor LLM can transcribe a confabulated file citation straight out of
// an assistant message (the incident: a turn that cited todos/2026-07-06.md
// — a file that never existed — produced a Σ pending item that re-injected
// into later sessions). This mechanical pre-merge check drops NEW patch
// items that cite a dated todos file absent from disk. Conservative scope:
// dated todos citations only, string array items only (confirmed /
// hypothesis / next), and patch items only — existing Σ content is never
// rewritten here (the Stop hook's ghost-file gate handles the live turn;
// this blocks propagation into the next session).
const GHOST_TODO_REF_RE = /((?:\/?[A-Za-z0-9._-]+\/)*todos\/\d{4}-\d{2}-\d{2}\.md)/g;

/**
 * Drop new patch items citing dated todos files that do not exist on disk.
 * @param {object} patch - extracted state patch (mutated in place)
 * @param {string} cwd - session working directory (relative-citation base)
 * @returns {{patch: object, removed: Array<{key: string, item: string, refs: string[]}>}} the (mutated) patch plus the removed items for telemetry
 */
function filterGhostRefs(patch, cwd) {
  const removed = [];
  if (!patch || typeof patch !== 'object' || !cwd) return { patch, removed };
  for (const key of FILTERABLE_KEYS) {
    const arr = patch[key];
    if (!Array.isArray(arr)) continue;
    patch[key] = arr.filter((item) => {
      if (typeof item !== 'string') return true;
      const ghosts = (item.match(GHOST_TODO_REF_RE) || []).filter((ref) => {
        const abs = path.isAbsolute(ref) ? ref : path.join(cwd, ref);
        let exists = false;
        try {
          exists = fs.existsSync(abs);
        } catch {}
        return !exists;
      });
      if (ghosts.length) removed.push({ key, item, refs: ghosts });
      return ghosts.length === 0;
    });
    if (patch[key].length === 0) delete patch[key];
  }
  return { patch, removed };
}

// Foreign-session state reference (2026-10-17 incident): the model reads
// ANOTHER session's Σ file (state/<uuid>.json) — e.g. during incident
// forensics — and the extraction LLM distills that citation (sometimes with
// the foreign session's facts) into THIS session's Σ. Re-injected, the
// foreign anchor re-latches the model onto another session's task. The
// pattern matches the 8-hex uuid prefix followed by either dash groups
// (full or partial uuid) or an elision marker (`…` / `...`). The dot
// before `json` is optional: the ASCII-dots form swallows it
// (`state/29a17fe5-...json`), while `…` leaves it (`-….json`). Plain
// project files like state/abcd1234.json (no dash, no elision) never match.
const FOREIGN_STATE_REF_RE = /state\/([0-9a-f]{8}(?:(?:-[0-9a-f]+)*-?(?:…|\.\.\.)|(?:-[0-9a-f]+)+))\.?json/g;

/**
 * Foreign session prefixes cited by a string — `state/<uuid>.json` refs whose
 * first 8 hex chars do not match the current session's id. Self-references
 * (the session citing its own Σ file) are allowed: the incident pattern is
 * foreign refs only.
 * @param {string} item
 * @param {string} sessionId - the current session's id
 * @returns {string[]} the foreign 8-hex prefixes (empty when clean)
 */
function foreignSessionRefs(item, sessionId) {
  if (typeof item !== 'string' || !sessionId) return [];
  const out = [];
  for (const m of item.matchAll(FOREIGN_STATE_REF_RE)) {
    const prefix = m[1].slice(0, 8);
    if (sessionId.slice(0, 8) !== prefix && !out.includes(prefix)) out.push(prefix);
  }
  return out;
}

/**
 * Drop new patch items citing OTHER sessions' state files. Mechanical
 * pre-merge gate (the extraction-prompt cross-session rule is the soft
 * layer). Patch items only — existing Σ content is scrubbed at presentation
 * time (userprompt-inject-state.js / sessionstart-inject-state.js), which
 * also cleans Σ files written before this filter existed.
 * @param {object} patch - extracted state patch (mutated in place)
 * @param {string} sessionId - the current session's id
 * @returns {{patch: object, removed: Array<{key: string, item: string, refs: string[]}>}} the (mutated) patch plus the removed items for telemetry
 */
function filterForeignSessionRefs(patch, sessionId) {
  const removed = [];
  if (!patch || typeof patch !== 'object' || !sessionId) return { patch, removed };
  for (const key of FILTERABLE_KEYS) {
    const arr = patch[key];
    if (!Array.isArray(arr)) continue;
    patch[key] = arr.filter((item) => {
      const refs = foreignSessionRefs(item, sessionId);
      if (refs.length) removed.push({ key, item, refs });
      return refs.length === 0;
    });
    if (patch[key].length === 0) delete patch[key];
  }
  return { patch, removed };
}

/**
 * Scrub a loaded Σ's content sections of foreign-session state refs (in
 * place). Presentation-time gate: covers Σ files written before
 * filterForeignSessionRefs existed and any leak the merge gate missed, so a
 * foreign anchor is never re-presented to the model.
 * @param {object} sigma - the loaded Σ (mutated in place)
 * @param {string} sessionId - the current session's id
 * @returns {Array<{key: string, item: string, refs: string[]}>} the removed items for telemetry
 */
function scrubSigmaForeignRefs(sigma, sessionId) {
  const removed = [];
  if (!sigma || typeof sigma !== 'object' || !sessionId) return removed;
  for (const key of FILTERABLE_KEYS) {
    const arr = sigma[key];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((item) => {
      const refs = foreignSessionRefs(item, sessionId);
      if (refs.length) removed.push({ key, item, refs });
      return refs.length === 0;
    });
    if (kept.length !== arr.length) sigma[key] = kept;
  }
  return removed;
}

/**
 * Completion-signal patterns for the mechanical task-switch flip
 * (2026-10-15 stale-anchor incident). A superset of check-writeback.js's
 * COMPLETION_PATTERNS — same conservative base set, intentionally NOT shared
 * (check-writeback gates a user-facing ask and must not pick up new
 * patterns) plus commit/push-completion patterns: the incident's actual
 * completion signal ("커밋·푸시 완료") falls outside the check-writeback set.
 * Matched against the turn's final assistant message at Stop; the flag it
 * sets is consumed by the UserPromptSubmit hook's flip, so a false positive
 * costs at most one turn of state re-derivation (the flip marks the ORIGINAL
 * anchor done and wipes the current view, which the next extraction
 * re-derives from the live transcript).
 */
const COMPLETION_SIGNAL_PATTERNS = [
  /테스트.*통과|all checks?\s*pass/i,
  /버그?.*수정|bug.{0,5}fix|fixed the bug/i,
  /기능.*완성|구현 완료|feature delivered|implementation complete/i,
  /ready to commit|커밋.?해줘|commit this/i,
  /done with the changes|작업 완료|수정 완료/i,
  // Commit/push completion (the 2026-10-15 incident's signal) —
  // check-writeback's set predates it.
  /커밋[하하고]*[·\s]?푸시|커밋.{0,8}완료|푸시.{0,8}완료/i,
  /committed and pushed|successfully pushed/i,
];

/**
 * True when the given (final) assistant message carries a completion signal.
 * The Stop hook uses it to set sigma.last_turn_completion_signal; the
 * UserPromptSubmit hook consumes that flag as a mechanical anchor flip.
 * @param {string} message - the turn's final assistant message
 * @returns {boolean}
 */
function completionSignal(message) {
  if (typeof message !== 'string' || !message.trim()) return false;
  return COMPLETION_SIGNAL_PATTERNS.some((p) => p.test(message));
}

module.exports = {
  hasFileEvidence,
  hasResultEvidence,
  gateStripPatch,
  filterGhostRefs,
  foreignSessionRefs,
  filterForeignSessionRefs,
  scrubSigmaForeignRefs,
  completionSignal,
};
