#!/usr/bin/env node
// SessionEnd hook — remove this session's per-session state files
// (<sid>.json, <sid>.jsonl, legacy <sid>.recall.json, orphan *.tmp) and sweep
// files older than 7 days left by sessions that ended without a SessionEnd
// event (crash/kill). Also sweeps SKILL.state Σ files
// (~/.qwen/tmp/focus-memory/state/<sid>.json) — the persistent copy of the
// last state lives in work_memory (type "state_checkpoint"). Session work
// notes (~/.qwen/tmp/focus-memory/notes/<sid>.json) are NOT deleted for the
// ending session (they must survive a restart, plans/continous_work.md FR-1)
// — only the 7-day stale sweep applies.
// Best-effort: any failure is swallowed.

const fs = require('fs');
const state = require('./lib/state.js');
const skillstate = require('./lib/skillstate.js');
const notes = require('./lib/notes.js');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch { return; }

  const sessionId = event.session_id;
  if (sessionId) {
    state.sweepStale(0, `${sessionId}.`);
    skillstate.sweepSigma(0, `${sessionId}.`);
  }
  state.sweepStale(SEVEN_DAYS_MS);
  skillstate.sweepSigma(SEVEN_DAYS_MS);
  // Session notes survive the ending session (restart persistence, FR-1) —
  // only the 7-day stale sweep applies.
  notes.sweepNotes(SEVEN_DAYS_MS);
}

main();
