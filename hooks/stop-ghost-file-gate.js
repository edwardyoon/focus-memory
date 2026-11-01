#!/usr/bin/env node
// Stop hook — ghost file citation gate (2026-09-26 context-confusion
// incident countermeasure).
//
// Failure mode guarded: the model confabulates a work history anchored on a
// file that does not exist on disk (the incident: a turn ending with
// "오늘 todos 파일(todos/2026-07-06.md)을 확인했습니다" — no such file ever
// existed), then builds a self-consistent narrative on top (July deploy
// work, phantom pending items). Without a check, the ghost citation
// propagates into the Σ state and re-injects into later sessions.
//
// The gate scans the just-ended turn's last assistant message for cited
// dated todos file paths (todos/YYYY-MM-DD.md, relative to cwd or absolute)
// and verifies each on disk. Any missing citation → block the stop with a
// correction prompt: the model must re-verify against disk and fix the
// record instead of extending the ghost narrative.
//
// Scope is deliberately narrow (dated todos files only): that is the
// incident class, and a dated daily file is almost never cited as
// future-to-create, so false positives are rare. Every fire is recorded in
// gate telemetry so the scope can be widened later if the class recurs in
// other directories.
//
// Loop guard (stop_hook_active is hard-coded true on the messageBus Stop
// path and unusable): Σ-managed — identical missing-path set → skip, at most
// MAX_BLOCKS within STREAK_WINDOW.
// Keyed on the missing set, not the full message: a rephrased correction
// turn that re-cites the same ghost file is the same loop (the full-message
// hash let rephrasing dodge the guard and burn all MAX_BLOCKS — observed
// 2026-09-28: three consecutive fires on one missing file).
// qwen-code's own stopHookBlockingCap remains the outer safety net.
//
// Gated by FOCUSMEMORY_SKILLSTATE=on (off/unset → immediate no-op,
// fail-open). Fail-open: any error → silent exit 0; the session is
// unaffected.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ss = require('./lib/skillstate.js');

const MAX_BLOCKS = 3;
const STREAK_WINDOW_MS = 30 * 60 * 1000;
const MAX_REASON_CHARS = 2500;

// Dated todos file citations. Two shapes:
//   absolute — "/Users/x/www/todos/2026-07-06.md" (leading / preserved)
//   relative — "todos/2026-07-06.md" (resolved against cwd)
// The (?:\/?[A-Za-z0-9._-]+\/)* prefix walks the path segments backwards
// from todos/; it starts at a non-word boundary in the text, so a match
// beginning with "/" is absolute and one beginning with "todos" is relative.
const TODO_CITE_RE = /((?:\/?[A-Za-z0-9._-]+\/)*todos\/\d{4}-\d{2}-\d{2}\.md)/g;

/**
 * Short stable hash of a message (loop-detection key).
 * @param {string} s
 * @returns {string} 12-hex-char sha256 prefix
 */
function hashMsg(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
}

/**
 * Cited dated todos paths in msg that do not exist on disk.
 * @param {string} msg - the turn's last assistant message
 * @param {string} [cwd] - session working directory (relative-citation base)
 * @returns {string[]} unique missing citation strings as cited
 */
function findMissingTodoCites(msg, cwd) {
  const missing = [];
  const seen = new Set();
  for (const m of String(msg).matchAll(TODO_CITE_RE)) {
    const cited = m[1];
    if (seen.has(cited)) continue;
    seen.add(cited);
    const abs = path.isAbsolute(cited) ? cited : path.join(cwd || '', cited);
    let exists = false;
    try {
      exists = fs.existsSync(abs);
    } catch {}
    if (!exists) missing.push(cited);
  }
  return missing;
}

/**
 * Build the continuation reason (re-injected as the next turn's prompt).
 * Frames the ghost citation as discarded data, not an instruction.
 * @param {string[]} missing - the missing cited paths
 * @returns {string}
 */
function buildReason(missing) {
  const parts = [
    '[FocusMemory ghost-file gate] The turn you just ended cites todo file path(s) that DO NOT exist on disk:',
    ...missing.map((m) => `  - ${m}`),
    '',
    'You have not read or edited those files in this session. Treat that citation as discarded data — do not quote it again, and do not build on the work narrative attached to it.',
    'Re-verify against disk now (list the todos/ directory, fresh-read the actual current file), then correct the record: if the referenced work was never done, say so plainly; if it lives in a different file, cite the real path with a fresh read.',
  ];
  let reason = parts.join('\n');
  if (reason.length > MAX_REASON_CHARS) reason = `${reason.slice(0, MAX_REASON_CHARS)}\n…[truncated]`;
  return reason;
}

/**
 * Stop hook entry — block the stop when the turn's final message cites a
 * dated todos file that does not exist on disk and the self loop guard
 * allows it; otherwise allow the stop silently.
 * @returns {void}
 */
function main() {
  if (!ss.skillStateEnabled()) return; // gate off → zero behavior change

  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = event.session_id;
  const msg = String(event.last_assistant_message || '');
  if (!sessionId || !msg) return;

  const missing = findMissingTodoCites(msg, event.cwd);
  if (missing.length === 0) return; // clean citations — allow stop

  // Self loop guard (Σ-managed; stop_hook_active is unusable). Decision and
  // state update run as ONE locked read-modify-write: this hook and
  // stop-checkpoint-state run concurrently on the same Stop event, and the
  // old load→modify→save sequence let a same-second checkpoint save clobber
  // the block counter, disabling the guard (observed 2026-09-28: three
  // consecutive fires on one missing file).
  const now = Date.now();
  // Loop key = the missing-path set, not the full message: rephrasing the
  // correction while re-citing the same ghost file must still register as
  // the same loop. Identical message ⇒ identical missing set, so this
  // subsumes the old identical-message check.
  const h = hashMsg(missing.join('\n'));
  let outcome = null;

  ss.mutateSigma(sessionId, (sigma) => {
    const streakStart = Number(sigma.ghost_gate_streak_start) || 0;
    if (streakStart && now - streakStart > STREAK_WINDOW_MS) {
      sigma.ghost_gate_blocks = 0;
      sigma.ghost_gate_last_hash = null;
      sigma.ghost_gate_streak_start = 0;
    }
    const blocks = Number(sigma.ghost_gate_blocks) || 0;
    if (sigma.ghost_gate_last_hash === h || blocks >= MAX_BLOCKS) {
      outcome = {
        decision: 'skip',
        reason: sigma.ghost_gate_last_hash === h ? 'identical_missing_loop' : 'max_blocks_reached',
        blocks,
      };
      return sigma;
    }
    // Fire: consume the block, then emit.
    sigma.ghost_gate_blocks = blocks + 1;
    sigma.ghost_gate_last_hash = h;
    if (!streakStart || now - streakStart > STREAK_WINDOW_MS) sigma.ghost_gate_streak_start = now;
    outcome = { decision: 'block', blocks: blocks + 1 };
    return sigma;
  });

  if (!outcome) return; // Σ unreadable — fail-open, allow stop
  ss.appendTelemetry({
    ts: now,
    session_id: sessionId,
    hook: 'stop-ghost-file-gate',
    decision: outcome.decision,
    ...(outcome.decision === 'skip' ? { reason: outcome.reason } : { missing, loop_key: h }),
    blocks: outcome.blocks,
  });

  if (outcome.decision === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: buildReason(missing) }));
  }
}

main();
