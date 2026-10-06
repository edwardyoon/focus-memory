#!/usr/bin/env node
// PostCompact hook — SKILL.state: bump Σ.compact_count on every real compaction
// so the post-compaction anchor window (userprompt-inject-state.js) opens on the
// first turn after compaction. The previous sole increment (SessionStart
// source=compact) fired 0x in the 2026-10-06 incident (session 7ee2e810);
// PostCompact is the dedicated "compaction succeeded" event. Deduped against the
// SessionStart fallback via a 30s window in ss.bumpCompactCount.
//
// Gated by FOCUSMEMORY_SKILLSTATE=on. Fail-open: any error -> silent exit 0.
// Always appends a telemetry entry on fire (even when dedup skips) so we can
// distinguish "fired but deduped" from "did not fire" during verification.

const fs = require('fs');
const ss = require('./lib/skillstate.js');

function main() {
  if (!ss.skillStateEnabled()) return;
  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try { event = JSON.parse(raw); } catch { return; }
  const sessionId = event.session_id;
  if (!sessionId) return;
  const newCount = ss.bumpCompactCount(sessionId);
  ss.appendTelemetry({
    ts: Date.now(),
    session_id: sessionId,
    hook: 'postcompact-bump-compact',
    event: newCount === null ? 'bump_deduped_or_nosigma' : 'compact_count_bumped',
    compact_count: newCount,
    trigger: event.trigger,
  });
}
try { main(); } catch { /* fail-open */ }
