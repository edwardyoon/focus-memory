#!/usr/bin/env node
// Stop hook — turn-end guard against "session stops after a bad summary".
//
// Failure mode guarded (plans/20260923-compaction-stop-investigation.md):
// mid-session, a turn whose user prompt was "keep working" ends with a
// model-written "session summary" that claims there is NO active task, and
// that summary becomes the turn's final output (end_turn). With no
// verification or re-entry mechanism, the session parks itself in a
// "waiting for instructions" state while the real work anchor (Σ state /
// in-progress todos) still exists on disk.
//
// The guard fires when the turn result matches a failure shape AND an
// active anchor exists (conservative by design — a legitimate "summarize
// the session" request or a genuine end-of-work must pass through):
//   A. summary shape   — the turn result carries a session-summary title
//                        marker (e.g. "# 세션 요약", "state snapshot")
//                        AND a no-task claim (B).
//   A2. greeting shape — the turn result is a fresh-session greeting asking
//                        for a task (post-compaction identity reset, e.g.
//                        "어떤 작업을 도와드릴까요?"). Fires alone (no B).
//   B. no-task claim   — the summary asserts there is no active task /
//                        the session is waiting for instructions.
//   C. active anchor   — Σ has confirmed / next items (three-section schema;
//                        legacy task_summary / current_step / pending_checks
//                        also count), OR today's todos file has [~] / [!] items.
//
// On fire: emit decision "block" with a continuation reason that (1) declares
// the just-written summary discarded, (2) re-injects the work anchor, (3)
// instructs the model to resume the in-flight work instead of re-summarizing.
// qwen-code feeds that reason back as the next turn's prompt (verified in
// 0.24.0: isBlockingDecision() → getStopHookContinuationReason() →
// sendMessageStream).
//
// Loop guard: stop_hook_active is hard-coded true on the messageBus Stop
// path (unusable), so the hook self-limits via Σ fields:
//   - identical message hash as the last blocked one → skip (true loop),
//   - at most MAX_BLOCKS within a STREAK_WINDOW → skip,
//   - the streak window resets after the quiet period.
// qwen-code's own stopHookBlockingCap (default 8) remains the outer safety
// net; self-limiting keeps this hook from starving that shared budget.
//
// Gated by FOCUSMEMORY_SKILLSTATE=on (off/unset → immediate no-op, fail-open).
// Fail-open: any error → silent exit 0; the session is unaffected.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ss = require('./lib/skillstate.js');

const MAX_BLOCKS = 3;
const STREAK_WINDOW_MS = 30 * 60 * 1000;
const MAX_REASON_CHARS = 2500;

// A. session-summary shape markers (title / structure).
const SUMMARY_SHAPE = [
  /#\s*세션\s*요약/,
  /세션\s*요약/,
  /session\s+summary/i,
  /state\s+snapshot/i,
  /<state_snapshot>/,
  /##\s*현재\s*상태/,
  /##\s*다음\s*단계/,
];

// B. "no active task" claims.
const NO_TASK_CLAIM = [
  /작업\s*요청\s*아직\s*없음/,
  /작업\s*지시\s*대기/,
  /작업(이|가)?\s*없(음|는)/,
  /요청(이|가)?\s*없(음|는)/,
  /대기\s*중/,
  /no\s+active\s+task/i,
  /no\s+task\s+(to|awaiting)/i,
  /waiting\s+for\s+(your\s+)?(instructions|input|next)/i,
  /nothing\s+(to\s+do|pending)/i,
];

// A2. fresh-session greeting shape (the post-compaction identity-reset
// failure mode: the model re-identifies as a brand-new session — typically
// anchored on the system prompt's repo context — and asks for a task while
// a work anchor still exists on disk. The greeting itself is the no-task
// claim, so A2 fires without an explicit B match.)
const GREETING_SHAPE = [
  /무엇을 도와드릴까요/,
  /어떤 작업을 (진행할까요|도와드릴까요|시작할까요)/,
  /what can i help (you )?with/i,
  /how can i help/i,
  /is there anything i can (do|help)/i,
];

// Task-unit completion reports (2026-10-03): the model reports a unit of work
// as DONE and cites what was changed/verified. Such a report is a legitimate
// stop — the guard must not force a "resume" of already-complete work (the
// stale-anchor problem is compounded when the guard blocks a real completion
// and the model re-enters finished work). A bare "no task" parking message
// WITHOUT completion evidence still blocks (that is the bad-summary failure
// mode). Both a completion claim (COMPLETION_SHAPE) AND concrete evidence
// (COMPLETION_PROOF) are required to keep false positives minimal.
const COMPLETION_SHAPE = [
  /(작업|태스크|task)\s*(이|가)?\s*(완료|종료|마감|끝)/i,
  /모든\s*(작업|태스크|task|항목)\s*(이|가)?\s*(완료|종료|마감)/i,
  /(완료|종료|마감)\s*되었습니다/i,
  /all\s+tasks?\s+(are\s+)?(complete|done|finished)/i,
  /task\s+(is\s+)?(complete|done|finished)/i,
  /work\s+(is\s+)?(complete|done|finished)/i,
];
const COMPLETION_PROOF = [
  /(파일|코드|함수|스크립트|file|files?|code|function|script)/i,
  /(테스트|test|tests?|스위트|suite|통과|pass|passed)/i,
  /(검증|verify|verified|확인|실행|커밋|commit|node --check|php -l)/i,
  /(수정|변경|추가|생성|작성|적용|반영|deploy|배포)/i,
];

/**
 * Short stable hash of a message (loop-detection key).
 * @param {string} s
 * @returns {string} 12-hex-char sha256 prefix
 */
function hashMsg(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
}

/**
 * First-match index of any pattern in s, or -1.
 * @param {string} s
 * @param {RegExp[]} patterns
 * @returns {number}
 */
function firstMatch(s, patterns) {
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].test(s)) return i;
  }
  return -1;
}

/**
 * In-progress items from today's todos file ([~] in-progress, [!] partial/
 * interrupted headers). Empty array when the file is absent or clean.
 * @param {string} cwd
 * @returns {string[]}
 */
function inProgressTodos(cwd) {
  if (!cwd) return [];
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const file = path.join(cwd, 'todos', `${ymd}.md`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const items = [];
  for (const line of raw.split('\n')) {
    if (/^##\s*\[(~|!)\]\s*(.+)$/.test(line)) {
      items.push(line.replace(/^##\s*\[(~|!)\]\s*/, '').trim());
    }
  }
  return items.slice(0, 5);
}

/**
 * Build the continuation reason (re-injected as the next turn's prompt).
 * Frames the bad summary as discarded DATA, not an instruction — the direct
// counter to the summarization role-misattribution (investigation §3.1).
 * @param {object} sigma
 * @param {string[]} todos
 * @returns {string}
 */
function buildReason(sigma, todos) {
  const parts = [
    '[FocusMemory turn-guard] The turn you just ended either wrote a "session summary" claiming there is no active task, or reset to a fresh-session greeting asking for a task. The work anchor below shows ongoing work, so that framing is INCORRECT. Treat the summary/greeting as discarded data — do not extend, repeat, or build on it, and do not re-introduce yourself as a new session.',
    '',
  ];
  const anchor = ss.renderAnchor(sigma);
  if (anchor) {
    parts.push('Active work anchor (execution state Σ):', `  ${anchor}`, '');
  }
  if (todos.length) {
    parts.push('In-progress todos (today):');
    for (const t of todos) parts.push(`  - ${t}`);
    parts.push('');
  }
  parts.push(
    'Resume the in-flight work from its last completed step. If you judge the work genuinely complete, state the completion with concrete evidence (files changed, tests run) instead of summarizing.',
  );
  let reason = parts.join('\n');
  if (reason.length > MAX_REASON_CHARS) reason = `${reason.slice(0, MAX_REASON_CHARS)}\n…[truncated]`;
  return reason;
}

/**
 * Stop hook entry — evaluate the just-ended turn; block with a work-anchor
 * continuation reason only when summary-shape + no-task-claim + active anchor
 * all hold, and the self loop guard allows it.
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

  // A + B on the turn result (summary shape), or A2 alone (greeting shape —
  // the greeting itself asserts "no task" by asking for one).
  const shapeIdx = firstMatch(msg, SUMMARY_SHAPE);
  const greetIdx = firstMatch(msg, GREETING_SHAPE);
  const noTaskIdx = firstMatch(msg, NO_TASK_CLAIM);
  const failureShape = (shapeIdx !== -1 && noTaskIdx !== -1) || greetIdx !== -1;
  if (!failureShape) return; // not the failure shape — allow stop

  // Task-unit completion report: a genuine "done" with concrete evidence is a
  // legitimate stop — the guard must not force a "resume" of already-complete
  // work (2026-10-03: the stale-anchor problem is compounded when the guard
  // blocks a real completion and the model re-enters finished work). Requires
  // BOTH a completion claim and evidence, so a bare "no task" parking message
  // still falls through to the block logic below.
  if (firstMatch(msg, COMPLETION_SHAPE) !== -1 && firstMatch(msg, COMPLETION_PROOF) !== -1) {
    ss.appendTelemetry({
      ts: Date.now(),
      session_id: sessionId,
      hook: 'stop-turn-guard',
      decision: 'completion_allowed',
    });
    return;
  }

  // C — active work anchor.
  const sigma = ss.loadSigma(sessionId);
  const sigmaActive = !!(
    (Array.isArray(sigma.confirmed) && sigma.confirmed.length > 0) ||
    (Array.isArray(sigma.next) && sigma.next.length > 0) ||
    // Legacy (pre-2026-10-09 Σ files with the flat keys)
    (typeof sigma.task_summary === 'string' && sigma.task_summary.trim()) ||
    (typeof sigma.current_step === 'string' && sigma.current_step.trim()) ||
    (Array.isArray(sigma.pending_checks) && sigma.pending_checks.length > 0)
  );
  const todos = inProgressTodos(event.cwd);
  if (!sigmaActive && todos.length === 0) return; // no anchor — the claim may be true

  // Self loop guard (Σ-managed; stop_hook_active is unusable — hard-coded
  // true). Decision + state update as ONE locked read-modify-write: the Stop
  // hooks run concurrently on the same event, and the old load→modify→save
  // sequence let same-second saves clobber the block counter (lost update —
  // observed 2026-09-28 disabling the ghost-gate loop guard).
  const now = Date.now();
  const h = hashMsg(msg);
  let outcome = null;
  let written = null;

  written = ss.mutateSigma(sessionId, (cur) => {
    const streakStart = Number(cur.turn_guard_streak_start) || 0;
    if (streakStart && now - streakStart > STREAK_WINDOW_MS) {
      cur.turn_guard_blocks = 0;
      cur.turn_guard_last_hash = null;
      cur.turn_guard_streak_start = 0;
    }
    const blocks = Number(cur.turn_guard_blocks) || 0;
    if (cur.turn_guard_last_hash === h) {
      outcome = { decision: 'skip', reason: 'identical_message_loop', blocks };
      return cur;
    }
    if (blocks >= MAX_BLOCKS) {
      outcome = { decision: 'skip', reason: 'max_blocks_reached', blocks };
      return cur;
    }
    // Fire: consume the block, then emit.
    cur.turn_guard_blocks = blocks + 1;
    cur.turn_guard_last_hash = h;
    if (!streakStart || now - streakStart > STREAK_WINDOW_MS) cur.turn_guard_streak_start = now;
    outcome = { decision: 'block', blocks: blocks + 1 };
    return cur;
  });

  if (!outcome) return; // Σ unreadable — fail-open, allow stop
  ss.appendTelemetry({
    ts: now,
    session_id: sessionId,
    hook: 'stop-turn-guard',
    decision: outcome.decision,
    ...(outcome.decision === 'skip'
      ? { reason: outcome.reason }
      : {
          shape: greetIdx !== -1 && (shapeIdx === -1 || noTaskIdx === -1) ? 'greeting' : 'summary',
          shape_idx: shapeIdx,
          greet_idx: greetIdx,
          no_task_idx: noTaskIdx,
          anchor: { sigma: sigmaActive, todos: todos.length },
        }),
    blocks: outcome.blocks,
    msg_hash: h,
  });

  if (outcome.decision === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: buildReason(written || sigma, todos) }));
  }
}

main();
