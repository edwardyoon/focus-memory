// P0-4 anchor mapping + P1-2 budget render tests (spec §2 A-6, §3 B-7).
// Run: node test/sigma-anchor-map.test.js
// No test framework — node:assert + a tiny runner.
// ESM (root package.json is type:module); skillstate.js is CJS under
// hooks/package.json, imported as the default export.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import skillState from '../hooks/lib/skillstate.js';

let nPassed = 0;
const failures = [];
async function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-test-'));
  try {
    await fn(dir);
    nPassed++;
    console.log(`ok ${nPassed}: ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.error(`FAIL: ${name}\n${(e && e.stack) || e}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Build a JSONL file from an array of lines (each written with a trailing
// \n). Returns { p, offsets } where offsets[i] is the absolute byte offset
// where line i starts.
function writeJsonl(dir, name, lines) {
  const offsets = [];
  let off = 0;
  for (const l of lines) {
    offsets.push(off);
    off += Buffer.byteLength(l, 'utf8') + 1;
  }
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return { p, offsets };
}

const userLine = (text) => JSON.stringify({ type: 'user', message: { parts: [{ text }] } });
const metaLine = () => JSON.stringify({ type: 'system', subtype: 'ui_telemetry' });
const asstLine = (ids) => JSON.stringify({ type: 'assistant', message: { parts: ids.map((id) => ({ functionCall: { name: 'f', id } })) } });
const toolLine = (ids) => JSON.stringify({ type: 'tool_result', message: { parts: ids.map((id) => ({ functionResponse: { name: 'f', id, response: { ok: true } } })) } });

// ── Task A: anchor mapping (spec A-6) ──────────────────────────────────

// 1: parallel tool_result (3 functionResponse parts in ONE entry) — the
// anchor maps to the exact user-line start while the legacy count method
// lands elsewhere (the C++ array has 3 tool messages, the transcript has
// 1 entry).
await test('1: parallel tool_result — anchor exact, count off', async (dir) => {
  const lines = [
    metaLine(),
    userLine('first question alpha'),
    asstLine(['c1', 'c2', 'c3']),
    toolLine(['c1', 'c2', 'c3']),
    userLine('second question beta'),
    userLine('third question gamma'),
  ];
  const { p, offsets } = writeJsonl(dir, 't1.jsonl', lines);
  // C++ view: [0]=system [1]=U1 [2]=A1 [3..5]=3 tool msgs [6]=U2 [7]=U3
  // → cut for U2 = 6; ordinal = users before index 6 = 1.
  const anchor = { text: skillState.anchorNorm('second question beta'), ordinal: 1 };
  const hit = await skillState.findAnchorOffset(p, anchor);
  assert.ok(hit, 'anchor should match');
  assert.strictEqual(hit.off, offsets[4], 'anchor offset == U2 line start');
  const countOff = await skillState.transcriptByteOffsetForMessageIndex(p, 6);
  assert.notStrictEqual(countOff, offsets[4], 'count method lands elsewhere (drift)');
  const r = await skillState.resolveAbsorbTo(p, 6, 0, anchor);
  assert.strictEqual(r.map, 'anchor');
  assert.strictEqual(r.toBytes, offsets[4]);
});

// 2: the same "계속해줘" user text twice — the ordinal hint picks the
// closer entry; without an ordinal the most recent match wins.
await test('2: duplicate user text — ordinal picks the closer entry', async (dir) => {
  const lines = [userLine('계속해줘'), metaLine(), userLine('계속해줘'), userLine('done')];
  const { p, offsets } = writeJsonl(dir, 't2.jsonl', lines);
  const n = skillState.anchorNorm('계속해줘');
  const hit1 = await skillState.findAnchorOffset(p, { text: n, ordinal: 1 });
  assert.strictEqual(hit1.off, offsets[2], 'ordinal 1 → the second 계속해줘');
  const hit0 = await skillState.findAnchorOffset(p, { text: n, ordinal: 0 });
  assert.strictEqual(hit0.off, offsets[0], 'ordinal 0 → the first 계속해줘');
  const noOrd = await skillState.findAnchorOffset(p, { text: n });
  assert.strictEqual(noOrd.off, offsets[2], 'no ordinal → most recent match');
});

// 3: an injected <system-reminder> inside the user text — the index
// normalizes it away (stripInjectedBlocks), so the C++ fingerprint (also
// stripped) matches; the raw fingerprint must NOT match.
await test('3: injected <system-reminder> in user text — stripped on both sides', async (dir) => {
  const raw = 'fix the login bug <system-reminder>INJECTED CONTEXT</system-reminder> and run tests';
  const { p, offsets } = writeJsonl(dir, 't3.jsonl', [userLine(raw)]);
  const hit = await skillState.findAnchorOffset(p, { text: skillState.anchorNorm(raw) });
  assert.ok(hit && hit.off === offsets[0], 'stripped fingerprint matches');
  const rawNorm = Array.from(raw.replace(/[ \t\r\n]+/g, '')).slice(0, 60).join('');
  const miss = await skillState.findAnchorOffset(p, { text: rawNorm });
  assert.strictEqual(miss, null, 'raw (unstripped) fingerprint must not match');
});

// 4: 60-code-point boundary with Korean + emoji. The expected literal is
// copied verbatim into the C++ test C1(e) — a mismatch there is a
// C++/JS parity bug. (58 Korean + 12 emoji = 70 code points → keep 60.)
await test('4: 60-code-point boundary (Korean + emoji) — C++ parity string', async (dir) => {
  const input = '가'.repeat(58) + '\u{1F600}'.repeat(12);
  const expected = '가'.repeat(58) + '\u{1F600}'.repeat(2);
  assert.strictEqual(skillState.anchorNorm(input), expected);
  // Whitespace interleaved (stripped before truncation):
  const spaced = '가'.repeat(58).split('').join(' ') + '\u{1F600}'.repeat(12);
  assert.strictEqual(skillState.anchorNorm(spaced), expected);
});

// 5: anchor miss — resolveAbsorbTo falls back to the legacy count mapping.
await test('5: anchor miss — falls back to count mapping', async (dir) => {
  const lines = [userLine('alpha one'), userLine('beta two'), userLine('gamma three')];
  const { p, offsets } = writeJsonl(dir, 't5.jsonl', lines);
  const r = await skillState.resolveAbsorbTo(p, 2, 0, { text: 'zzz-not-present' });
  assert.strictEqual(r.map, 'count');
  assert.strictEqual(r.toBytes, offsets[1], 'cut=2 → 1st chat entry = line 1');
});

// 6: incremental scan — an appended complete user line is indexed on the
// second call; a partial trailing line (no newline) is not scanned.
await test('6: incremental scan — appended line indexed, partial excluded', async (dir) => {
  const l1 = [userLine('early one'), userLine('early two')];
  const { p, offsets } = writeJsonl(dir, 't6.jsonl', l1);
  const r1 = await skillState.findAnchorOffset(p, { text: skillState.anchorNorm('early two') });
  assert.strictEqual(r1.off, offsets[1]);
  const line3 = userLine('appended three');
  const partial = userLine('partial four');
  fs.appendFileSync(p, line3 + '\n' + partial, 'utf8');
  const r3 = await skillState.findAnchorOffset(p, { text: skillState.anchorNorm('appended three') });
  assert.ok(r3, 'appended line indexed');
  assert.strictEqual(r3.off, offsets[1] + Buffer.byteLength(l1[1], 'utf8') + 1);
  const r4 = await skillState.findAnchorOffset(p, { text: skillState.anchorNorm('partial four') });
  assert.strictEqual(r4, null, 'partial (no trailing newline) line not scanned');
});

// 7: the file shrinks (truncate) — the index restarts the scan.
await test('7: truncated file — full rescan', async (dir) => {
  const lines = [userLine('keep one'), userLine('cut two'), userLine('cut three')];
  const { p, offsets } = writeJsonl(dir, 't7.jsonl', lines);
  const r1 = await skillState.findAnchorOffset(p, { text: skillState.anchorNorm('cut three') });
  assert.strictEqual(r1.off, offsets[2]);
  fs.writeFileSync(p, lines[0] + '\n', 'utf8');
  const r2 = await skillState.findAnchorOffset(p, { text: skillState.anchorNorm('cut three') });
  assert.strictEqual(r2, null, 'entry gone after truncate');
  const r3 = await skillState.findAnchorOffset(p, { text: skillState.anchorNorm('keep one') });
  assert.strictEqual(r3.off, offsets[0], 'rescanned from the start');
});

// ── summary ────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n${failures.length} test(s) failed, ${nPassed} passed`);
  process.exit(1);
}
console.log(`\nall ${nPassed} tests passed`);
