#!/usr/bin/env node
// PreToolUse hook — log tool calls and track state flags for Hard Gate
// enforcement. search_memory stamps the satisfaction epoch (memoryCalledEpoch
// = current turnEpoch) so the gate can distinguish "searched THIS turn" from
// a stale stamp of an earlier turn.

const fs = require('fs');
const path = require('path');
const { updateState, appendTelemetry, rotateJsonl, STATE_DIR } = require('./lib/state.js');

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch { returnAllow(); }

  const sessionId = event.session_id;
  if (!sessionId) returnAllow();

  const toolName = event.tool_name || 'unknown';
  const logFile = path.join(STATE_DIR, `${sessionId}.jsonl`);

  // --- Flag updates in a single lock-protected write (see lib/state.js) ---
  updateState(sessionId, (s) => {
    const next = { ...s };
    if (toolName === 'mcp__focus-memory__search_memory') {
      next.memoryCalled = true;
      next.memoryCalledEpoch = Number.isFinite(s.turnEpoch) ? s.turnEpoch : 0;
      next.satisfiedBy = 'search_memory';
    }
    if (toolName.includes('remember_decision')) {
      next.decisionRecorded = true;
      delete next.decisionDeclined;
    }
    if (['edit', 'write_file'].includes(toolName)) {
      // New code edit means a new work unit started — clear old
      // decline/record so the write-back ask can fire again later.
      delete next.decisionDeclined;
      delete next.decisionRecorded;
    }
    return next;
  });

  if (toolName.includes('remember_decision')) {
    appendTelemetry({ ts: Date.now(), session_id: sessionId, hook: 'check-writeback', event: 'user_response', decision: 'yes', tool: toolName });
  }

  // Append to per-session audit log
  const line = JSON.stringify({ tool: toolName, ts: Date.now() }) + '\n';
  try {
    fs.appendFileSync(logFile, line);
    rotateJsonl(logFile);
  } catch {}

  returnAllow();
}

function returnAllow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
  }));
}

main();
