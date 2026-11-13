// SKILL.state transcript readers (CJS — hooks/ scope).
//
// Bounded I/O over the session transcript JSONL: the rule-based region digest,
// tail/delta/range readers, entry serialization, the C++ message-index →
// byte-offset mapping, and the P0-4 anchor index. Memory is O(longest line +
// rendered output), never O(file size).

const fs = require('fs');
const { CONFIG } = require('./config.js');
const { stripInjectedBlocks } = require('./kvoffload.js');

// ─── Anchor rendering + transcript digest ──────────────────────────────

/**
 * Rule-based digest of the recent transcript entries (recent_work MCP tool +
 * mid-turn Σ auto-injection, 2026-10-23). NO LLM: inside long autonomous
 * turns the model forgets its own recent actions (within-turn tool results
 * are evicted first, Σ lags by a turn), so the RAW transcript tail is the
 * freshest action record — compressed to tool name + target + status.
 *
 * Reads only the last 64KB of the transcript JSONL. The file is appended in
 * real time during a turn (verified 2026-10-23: entries land with age ~0s
 * mid-turn), so a mid-turn read sees the current turn's calls and results.
 * The first tail line is discarded when the 64KB cut lands mid-line (it may
 * be truncated JSON) and unparseable lines are skipped. `system` entries
 * (per-event bookkeeping, no message parts) are ignored; user/assistant
 * carry text parts, tool_result carries functionResponse parts.
 *
 * Line grammar (chronological, oldest→newest):
 *   HH:MM <tool> <target>|<command first 80 chars>   (assistant tool call)
 *   ok | error: <first 60 chars>                     (tool result — BODY NEVER:
 *   [ai] <first 100 chars>                           including bodies is what
 *   [user] <first 150 chars>                         would persist instructions
 *   read <path> ×N                                   embedded in web/file
 * Consecutive reads of the same file collapse to `read X ×N` (intermediate
 * result lines dropped); over maxChars the OLDEST lines drop first.
 * @param {string} transcriptPath - session transcript JSONL (event.transcript_path)
 * @param {object} [opts]
 * @param {number} [opts.events=24] - max transcript entries (tail window)
 * @param {number} [opts.maxChars=1600] - digest char cap
 * @returns {string} digest text; '' on any failure (fail-open)
 */
function digestTranscript(transcriptPath, opts = {}) {
  const events = Math.max(1, Number(opts.events) || 24);
  const maxChars = Math.max(200, Number(opts.maxChars) || 1600);
  if (!transcriptPath) return '';
  let tail;
  try {
    const size = fs.statSync(transcriptPath).size;
    const cut = size > TAIL_CHUNK_BYTES;
    const len = Math.min(size, TAIL_CHUNK_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      tail = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // First tail line may be cut mid-JSON at the byte boundary — discard it.
    if (cut) {
      const nl = tail.indexOf('\n');
      if (nl >= 0) tail = tail.slice(nl + 1);
    }
  } catch {
    return '';
  }
  const entries = [];
  for (const line of tail.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* skip unparseable (a torn append) */
    }
  }
  const hhmm = (ts) => (typeof ts === 'string' && ts.length >= 16 ? ts.slice(11, 16) : '');
  const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

  // {text, baseText, kind: 'read'|'result'|'call'|'text', readPath, count}
  const out = [];
  for (const e of entries.slice(-events)) {
    const parts = e.message && Array.isArray(e.message.parts) ? e.message.parts : [];
    const t = hhmm(e.timestamp);
    if (e.type === 'assistant') {
      for (const p of parts) {
        const fc = p.functionCall;
        if (!fc || typeof fc.name !== 'string') continue;
        const args = fc.args && typeof fc.args === 'object' ? fc.args : {};
        const target =
          typeof args.file_path === 'string' ? args.file_path
          : typeof args.path === 'string' ? args.path
          : '';
        const cmd =
          typeof args.command === 'string' ? args.command
          : typeof args.query === 'string' ? args.query
          : typeof args.pattern === 'string' ? args.pattern
          : '';
        if (fc.name === 'read_file' && target) {
          // Collapse consecutive same-file reads (result line may sit in
          // between) into `read X ×N`; intermediate results are dropped —
          // only the final status survives.
          let li = out.length - 1;
          if (
            li >= 1 && out[li].kind === 'result' &&
            out[li - 1].kind === 'read' && out[li - 1].readPath === target
          ) {
            out.pop();
            li -= 1;
          }
          if (li >= 0 && out[li].kind === 'read' && out[li].readPath === target) {
            const rd = out[li];
            rd.count = (rd.count || 1) + 1;
            rd.text = `${rd.baseText} ×${rd.count}`;
          } else {
            out.push({
              text: `${t} read ${target}`,
              baseText: `${t} read ${target}`,
              kind: 'read',
              readPath: target,
              count: 1,
            });
          }
        } else {
          const cmdPart = cmd ? `|${flat(cmd).slice(0, 80)}` : '';
          out.push({
            text: `${t} ${fc.name}${target ? ` ${target}` : ''}${cmdPart}`,
            kind: 'call',
          });
        }
      }
      const text = flat(parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join(' '));
      if (text) out.push({ text: `[ai] ${flat(stripInjectedBlocks(text)).slice(0, 100)}`, kind: 'text' });
    } else if (e.type === 'tool_result') {
      for (const p of parts) {
        const fr = p.functionResponse;
        if (!fr || !fr.response) continue;
        const err = fr.response.error;
        // Result BODY is never included — status only. This is what blocks
        // instructions embedded in web/file content from being persisted via
        // the digest into the Σ auto-injection.
        out.push({ text: err ? `error: ${flat(err).slice(0, 60)}` : 'ok', kind: 'result' });
      }
    } else if (e.type === 'user') {
      const text = flat(parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join(' '));
      if (text) out.push({ text: `[user] ${flat(stripInjectedBlocks(text)).slice(0, 150)}`, kind: 'text' });
    }
    // 'system' entries: bookkeeping only (no message parts) — ignored.
  }
  let lines = out.map((o) => o.text);
  while (lines.length > 1 && lines.join('\n').length > maxChars) {
    lines.shift(); // over budget → drop the OLDEST lines first
  }
  return lines.join('\n').slice(0, maxChars);
}

/**
 * Truncate a string to maxChars with an ellipsis marker.
 * @param {string} s
 * @param {number} maxChars
 * @returns {string}
 */
function clip(s, maxChars) {
  s = String(s);
  return s.length > maxChars ? `${s.slice(0, maxChars)}…[truncated]` : s;
}

/**
 * Serialize one transcript entry to compact text (or null to skip it).
 * Skips system snapshots; keeps user text, assistant text + tool calls,
 * and truncated tool results — enough to extract state, not the full history.
 * @param {object} entry - parsed JSONL line
 * @returns {string|null}
 */
function entryToText(entry) {
  if (!entry || !entry.type || !entry.message || !Array.isArray(entry.message.parts)) return null;
  const parts = [];
  for (const part of entry.message.parts) {
    if (entry.type === 'user' && part.text) {
      // P0-1: strip client-injected blocks (Σ anchor, system-reminder) so they
      // cannot roll back into the rendered digest / Σ hist. Skip if empty.
      const t = stripInjectedBlocks(part.text);
      if (t.trim()) parts.push(clip(t, 4000));
    } else if (entry.type === 'assistant' && part.text) {
      const t = stripInjectedBlocks(part.text);
      if (t.trim()) parts.push(clip(t, 4000));
    } else if (part.functionCall) {
      let args = '';
      try { args = JSON.stringify(part.functionCall.args || {}); } catch {}
      parts.push(`[call] ${part.functionCall.name} ${clip(args, 500)}`);
    } else if (part.functionResponse) {
      let resp = '';
      try { resp = JSON.stringify(part.functionResponse.response || {}); } catch {}
      parts.push(`[result ${part.functionResponse.name}] ${clip(resp, 800)}`);
    }
  }
  if (parts.length === 0) return null;
  const prefix = entry.type === 'user' ? '[user]' : entry.type === 'assistant' ? '[assistant]' : '[tool]';
  return `${prefix} ${parts.join(' | ')}`;
}

// ─── Bounded transcript I/O (task #17) ─────────────────────────────────────
// Transcripts grow to hundreds of MB; the hooks that read them are
// short-lived processes whose heap must stay small. extractTranscriptTail
// and extractLastUserMessage stream from EOF in 64KB chunks (walking back
// only as far as their stop condition needs), and
// transcriptByteOffsetForMessageIndex streams forward in 8MB chunks.
// Memory is O(longest line + rendered output), never O(file size).

const TAIL_CHUNK_BYTES = CONFIG.TAIL_CHUNK_BYTES;

/**
 * Walk a transcript JSONL's complete lines from the end (EOF) in 64KB
 * chunks, invoking fn(line) on each line newest-first. fn returns truthy
 * to stop the walk early; otherwise the walk runs to the start of the file.
 *
 * Chunk boundaries fall mid-line, so the oldest line of each window stays
 * a raw byte head (Buffer) and is re-joined with the previous chunk before
 * decoding — a UTF-8 sequence straddling the boundary decodes intact
 * (decoding per chunk would corrupt it to U+FFFD and break the line's
 * JSON.parse). The newest end of a window is always the true file end, so
 * every line after the first '\n' is complete. A line longer than a chunk
 * buffers across as many chunks as it spans (bounded by the line length,
 * not the file size); a file with no '\n' at all yields its content as one
 * line. Empty lines are skipped (the old full-read's filter(Boolean)).
 *
 * Sync (openSync/readSync): the callers are short-lived hook processes
 * that already do sync I/O, and the walk stops at their budget — the read
 * cost is bounded by the walk, not the file size. Fail-open: false on any
 * error.
 * @param {string} filePath
 * @param {(line: string) => any} fn - truthy return stops the walk
 * @returns {boolean} true when fn stopped the walk, false when the start
 *   of the file was reached (or the file was unreadable)
 */
function walkTranscriptLinesFromEnd(filePath, fn) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return false;
  }
  let size = 0;
  try {
    size = fs.fstatSync(fd).size;
  } catch {
    size = 0;
  }
  let pos = size; // the next chunk reads [max(0, pos - TAIL_CHUNK_BYTES), pos)
  let head = Buffer.alloc(0); // oldest line of the window, raw bytes (possibly truncated)
  let stopped = false;
  const emit = (line) => {
    if (stopped) return;
    if (fn(line)) stopped = true;
  };
  try {
    for (;;) {
      if (pos > 0) {
        const len = Math.min(TAIL_CHUNK_BYTES, pos);
        const buf = Buffer.alloc(len);
        const got = fs.readSync(fd, buf, 0, len, pos - len);
        if (got <= 0) break; // unexpected short read — fail open
        pos -= got;
        head = Buffer.concat([buf.subarray(0, got), head]);
      }
      const nl = head.indexOf(0x0a);
      if (nl < 0) {
        if (pos <= 0) {
          // No '\n' anywhere in the file — the whole content is one line.
          if (head.length) emit(head.toString('utf8'));
          break;
        }
        continue; // the oldest line starts before `pos` — read the previous chunk
      }
      // Everything after the first '\n' is complete lines (the window's
      // newest end is always the true file end).
      const rest = head.subarray(nl + 1).toString('utf8');
      head = Buffer.from(head.subarray(0, nl)); // re-copy: release the old buffer
      const lines = rest.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        emit(lines[i]);
        if (stopped) break;
      }
      if (stopped) break;
      if (pos <= 0) {
        // `head` is the file's first line (complete — not truncated).
        if (head.length) emit(head.toString('utf8'));
        break;
      }
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
  return stopped;
}

/**
 * Read the tail of a transcript JSONL within a character budget and render
 * it as compact text. Tail-based: the most recent work is what the next
 * post-compaction turn needs; earlier state is already accumulated in Σ.
 * Streamed from EOF in 64KB chunks (task #17) — memory is bounded by the
 * longest line + the rendered window, not the file size.
 * The budget is measured on RENDERED (post-clip) length, so one giant
 * tool_result line costs its clipped size (~800 chars), not its raw size.
 *
 * User-message guarantee (2026-10-03, incident a39ee3d9): the walk extends
 * past budgetChars (up to opts.maxChars) until at least opts.minUserEntries
 * user entries are in the window. Without this, a long all-assistant tail
 * (one big tool-heavy turn) pushes every user message beyond the budget —
 * the a39ee3d9 supersede sat 39,752 rendered chars back against a 30,000
 * budget — so the extractor never sees the task transition and
 * anchor_completed / anchor_revoked can never fire; the stale
 * first-user-message pin keeps steering the model.
 * @param {string} transcriptPath
 * @param {number} [budgetChars=30000]
 * @param {object} [opts]
 * @param {number} [opts.maxChars] hard cap on the extended window (default 3× budget)
 * @param {number} [opts.minUserEntries] user entries the window must contain (default 2)
 * @returns {string} compact text (empty string when nothing usable)
 */
function extractTranscriptTail(transcriptPath, budgetChars = CONFIG.BUDGET_CHARS, opts = {}) {
  if (!transcriptPath) return '';
  const maxChars = Math.max(budgetChars, opts.maxChars || budgetChars * 3);
  const minUserEntries = Math.max(1, opts.minUserEntries || 2);
  const rendered = [];
  let used = 0;
  let userEntries = 0;
  // Streamed from EOF in 64KB chunks (task #17): the old readFileSync +
  // split allocated O(file) for a walk that stops at the budget.
  walkTranscriptLinesFromEnd(transcriptPath, (line) => {
    if (used >= maxChars) return true; // old loop-head check
    let text = null;
    let isUser = false;
    try {
      const entry = JSON.parse(line);
      text = entryToText(entry);
      isUser = entry.type === 'user';
    } catch {}
    if (!text) return false;
    rendered.unshift(text);
    used += text.length + 1;
    if (isUser) userEntries++;
    // Stop early only once BOTH the budget and the user-message guarantee
    // hold; otherwise keep walking back (bounded by maxChars).
    if (used >= budgetChars && userEntries >= minUserEntries) return true;
    return false;
  });
  return rendered.join('\n');
}

/**
 * Read the transcript DELTA — the entries appended after a previous
 * extraction (fromBytes = the transcript size at that extraction, the
 * `last_extraction_transcript_bytes` offset). The transcript JSONL is
 * append-only (qwen only appends a `chat_compression` record on
 * compaction), so the byte offset is a stable "since" marker and only the
 * window [fromBytes, size) is read — no full-file scan.
 *
 * Why: the Stop-hook extraction sends the whole tail (up to TAIL_MAX_CHARS,
 * ~90k chars ≈ 20k+ tokens) every time, and the 8089 extractor prefills at
 * ~300 tok/s — a full turn's worth of tool calls meant 40-60s LLM calls,
 * which collided with the user's next message and lost the trigger to the
 * stale-worker guard. A delta is usually one turn (a few k tokens): seconds,
 * not minutes. The current Σ is passed in the prompt, so the snapshot
 * (replace) semantics do not need the older content.
 *
 * If the window exceeds maxChars (pathological: first extraction of a long
 * session, or many stale-skipped turns accumulated), keep the TAIL of the
 * window — same coverage bound as extractTranscriptTail's budget, and the
 * dropped head is older than the last Σ snapshot anyway.
 * @param {string} transcriptPath
 * @param {number} fromBytes - byte offset to start after (0 = from beginning)
 * @param {object} [opts]
 * @param {number} [opts.maxChars=30000] - max window size (tail of window kept)
 * @returns {string} rendered entries ('' when nothing new / unreadable)
 */
function extractTranscriptDelta(transcriptPath, fromBytes, opts = {}) {
  if (!transcriptPath) return '';
  const maxChars = Math.max(1000, Number(opts.maxChars) || CONFIG.BUDGET_CHARS);
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return '';
  }
  try {
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, Math.min(Number(fromBytes) || 0, size));
    let start = from;
    let capped = false;
    if (size - start > maxChars) {
      start = size - maxChars;
      capped = true;
    }
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (capped) {
      // `start` lands mid-line; drop the partial first line.
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    const rendered = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const t = entryToText(entry);
      if (t) rendered.push(t);
    }
    return rendered.join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read a BYTE RANGE of the transcript JSONL from the FRONT (plan §4.6, S5).
 * Unlike extractTranscriptDelta (which keeps the TAIL when capped — right for
 * "what's most recent"), the strip region is removed from the BEGINNING, so a
 * capped read must keep the HEAD and let the caller advance hist_last_bytes
 * chunk by chunk.
 *
 * P0-3: the budget is measured on RENDERED (post-clip) chars, not raw bytes.
 * The old raw-byte cap made one 30KB+ tool_result line either fill the whole
 * chunk (rendered to ~800 chars) or get skipped entirely — the root cause of
 * the ~87-pass / 1-hour drains. Lines are now consumed until the rendered
 * total reaches maxChars. The read window is 1MB; a line larger than the
 * window extends the read to 8MB; only lines beyond 8MB are skipped.
 * The trailing partial line is dropped at a LINE boundary in BYTES
 * (multi-byte/UTF-8 safe), so `consumed` is a byte offset the caller can
 * store in hist_last_bytes and re-read from on the next chunk.
 * @param {string} transcriptPath
 * @param {number} fromBytes - start offset (Σ.hist_last_bytes)
 * @param {number} toBytes - end offset (the cut boundary); <=0 means "to EOF"
 * @param {object} [opts]
 * @param {number} [opts.maxChars=30000] - cap on RENDERED chars; when the range is larger, the HEAD is kept
 * @returns {{text: string, entries: object[], consumed: number}} rendered text (for the LLM prompt), parsed entries (for the rule fallback), and bytes of complete lines consumed
 */
function extractTranscriptRange(transcriptPath, fromBytes, toBytes, opts = {}) {
  const empty = { text: '', entries: [], consumed: 0 };
  if (!transcriptPath) return empty;
  const maxChars = Math.max(1, Number(opts.maxChars) || CONFIG.BUDGET_CHARS);
  const WINDOW = CONFIG.RANGE_WINDOW_BYTES; // 1MB read window
  const MAX_LINE = CONFIG.MAX_LINE_BYTES; // 8MB max line; larger lines are skipped
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return empty;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, Math.min(Number(fromBytes) || 0, size));
    const to = toBytes > 0 ? Math.min(Number(toBytes), size) : size;
    if (to <= from) return empty;

    let pos = from;
    const rendered = [];
    const entries = [];
    let renderedChars = 0;
    let consumed = from;

    while (pos < to) {
      let len = Math.min(WINDOW, to - pos);
      let buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      // Last complete line in the window (bytes, not string indices —
      // multi-byte/UTF-8 safe).
      let lastNl = -1;
      for (let i = len - 1; i >= 0; i--) {
        if (buf[i] === 0x0a) { lastNl = i; break; }
      }
      if (lastNl < 0) {
        if (pos + len >= to) break; // range ends mid-line — the partial tail rides the next chunk
        if (len < MAX_LINE) {
          // Line larger than the 1MB window: extend the read to 8MB and retry.
          const newLen = Math.min(MAX_LINE, to - pos);
          buf = Buffer.alloc(newLen);
          fs.readSync(fd, buf, 0, newLen, pos);
          lastNl = -1;
          for (let i = newLen - 1; i >= 0; i--) {
            if (buf[i] === 0x0a) { lastNl = i; break; }
          }
          len = newLen;
        }
        if (lastNl < 0) {
          // Pathological line beyond 8MB: skip it (scan forward for its end).
          let skipPos = pos + len;
          let found = -1;
          while (skipPos < to) {
            const slen = Math.min(WINDOW, to - skipPos);
            const sbuf = Buffer.alloc(slen);
            fs.readSync(fd, sbuf, 0, slen, skipPos);
            const nl = sbuf.indexOf(0x0a);
            if (nl >= 0) { found = skipPos + nl; break; }
            skipPos += slen;
          }
          if (found < 0) break; // no line end before `to` — rides the next chunk
          pos = found + 1;      // skipped line: advance the cursor, not consumed
          continue;
        }
      }
      // Process every complete line in [pos, pos+lastNl+1).
      const complete = buf.toString('utf8', 0, lastNl + 1);
      for (const line of complete.split('\n')) {
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        entries.push(entry);
        const t = entryToText(entry);
        if (t) { rendered.push(t); renderedChars += t.length + 1; }
      }
      consumed = pos + lastNl + 1;
      pos = consumed;
      if (renderedChars >= maxChars) break; // rendered budget reached — the rest rides the next pass
    }
    // consumed is an ABSOLUTE file offset — the route persists it as
    // hist_last_bytes and passes it back as fromBytes.
    return { text: rendered.join('\n'), entries, consumed };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Rule-based history for a removed region (plan §4.5, S6) — the deterministic
 * fallback when LLM extraction fails or times out, so the Σ lineage never
 * breaks. Extracts ONLY what the transcript structurally shows (no inference,
 * no tool-result bodies): files read/edited, shell commands (first 60 chars),
 * and past user requests (first 100 chars, prefixed "asked:" so they survive
 * the imperative gate). Returns a strip patch (short keys + hist_files_*)
 * ready for gateStripPatch({skipEvidence:true}) + mergeStripPatch.
 * @param {object[]} entries - parsed transcript entries for the region
 * @returns {object} the strip patch
 */
function ruleHistFromEntries(entries) {
  const patch = {};
  if (!Array.isArray(entries)) return patch;
  const read = new Set();
  const edited = new Set();
  const done = [];
  const requests = [];
  const EDIT_TOOLS = new Set(['edit', 'write_file', 'notebook_edit']);
  for (const entry of entries) {
    if (!entry || !entry.message || !Array.isArray(entry.message.parts)) continue;
    for (const part of entry.message.parts) {
      if (!part) continue;
      if (part.functionCall) {
        const name = part.functionCall.name || '';
        const args = part.functionCall.args || {};
        if (name === 'read_file' && typeof args.file_path === 'string') read.add(args.file_path);
        else if (EDIT_TOOLS.has(name) && typeof args.file_path === 'string') edited.add(args.file_path);
        else if (name === 'run_shell_command' && typeof args.command === 'string') {
          const cmd = args.command.replace(/\s+/g, ' ').trim().slice(0, 60);
          if (cmd) done.push(`ran: ${cmd}`);
        }
      } else if (part.functionResponse) {
        // Result status only (ok/error) — never the result body.
        const r = part.functionResponse.response;
        const s = typeof r === 'string' ? r : (r && typeof r.error === 'string' ? r.error : '');
        if (s && /\b(error|fail(?:ed)?|exception|timeout)\b/i.test(s) && done[done.length - 1] && done[done.length - 1].startsWith('ran:')) {
          done[done.length - 1] += ' (error)';
        }
      } else if (entry.type === 'user' && typeof part.text === 'string' && part.text.trim()) {
        // P0-1: strip injected blocks before distilling the "asked:" request —
        // a Σ anchor / system-reminder user entry must not become a request.
        const stripped = stripInjectedBlocks(part.text).trim().replace(/\s+/g, ' ');
        if (stripped) {
          const t = `asked: ${stripped.slice(0, 100)}`;
          if (!requests.includes(t)) requests.push(t);
        }
      }
    }
  }
  if (read.size) patch.hist_files_read = [...read];
  if (edited.size) patch.hist_files_edited = [...edited];
  if (done.length) patch.done = done.slice(-20);
  if (requests.length) patch.requests = requests.slice(-10);
  return patch;
}

/**
 * Best-effort mapping of a C++ message index (cut = K_sum) to a transcript
 * byte offset (plan §5.5).
 *
 * 실측 (b6f4f035 transcript): the JSONL interleaves chat-message entries
 * (type user/assistant/tool_result, carrying message.parts) with meta
 * entries (type=system: ui_telemetry / file_history_snapshot /
 * attribution_snapshot, NO message). Counting every parsed line is therefore
 * systematically wrong (off by the meta count). The robust mapping
 * (tool_call_id / boundary-text search) is still the follow-up; this counts
 * only chat-message entries and applies the system offset:
 *
 *   C++ `cut` indexes the ORIGINAL messages array, where index 0 is the
 *   system prompt (no transcript entry). So C++ message [cut] — the first
 *   NON-removed message, i.e. the end of the removed region — is the
 *   (cut-1)-th chat-message entry. We return the byte offset where it begins.
 *
 * Returns 0 when it cannot be determined (fail-open — the caller then does
 * not advance and returns the current Σ as partial).
 * @param {string} transcriptPath
 * @param {number} cut - the message index to map
 * @returns {Promise<number>} byte offset, or 0
 */
async function transcriptByteOffsetForMessageIndex(transcriptPath, cut) {
  if (!transcriptPath || !(cut > 0)) return 0;
  let fh;
  try {
    fh = await fs.promises.open(transcriptPath, 'r');
  } catch {
    return 0;
  }
  let size = 0;
  try {
    size = (await fh.stat()).size;
  } catch {
    try { await fh.close(); } catch {}
    return 0;
  }
  // Streamed forward in 8MB chunks (task #17): the old promises.readFile
  // held the whole file (O(file)) while counting lines. The partial
  // trailing line is carried across chunk boundaries as raw bytes (a
  // UTF-8 sequence straddling a boundary decodes intact), and the final
  // unterminated line is counted like the old split('\n') did. Every
  // complete line is \n-terminated, so its byte cost is line+1 — the
  // offset stays byte-aligned across empty lines (item 7).
  const CHUNK = CONFIG.MAX_LINE_BYTES;
  let pos = 0; // file position of the first unread byte
  let base = 0; // absolute offset where the current data/carry starts
  let carry = Buffer.alloc(0); // tail without newline → next chunk
  let count = 0; // chat-message entries seen so far
  /**
   * Count one line: return its absolute start offset when it is the
   * (cut-1)-th chat-message entry, else null (advancing `count`).
   * @param {Buffer} lineBuf - the line without its trailing newline
   * @param {number} absOff - absolute byte offset where the line starts
   * @returns {number|null}
   */
  const targetOffset = (lineBuf, absOff) => {
    let entry;
    try {
      entry = lineBuf.length ? JSON.parse(lineBuf.toString('utf8')) : null;
    } catch {
      entry = null;
    }
    // Same test as entryToText / ruleHistFromEntries: a chat-message entry
    // carries message.parts. Meta entries (type=system, no message) fail it.
    const isChatMsg = !!(entry && entry.message && Array.isArray(entry.message.parts));
    if (!isChatMsg) return null;
    // C++[cut] = chat entry (cut-1); return the offset where it begins.
    if (count === cut - 1) return absOff;
    count++;
    return null;
  };
  try {
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.alloc(len);
      const res = await fh.read(buf, 0, len, pos);
      // Node >= 24 resolves {bytesRead, buffer}; older versions a number.
      const got = typeof res === 'number' ? res : res.bytesRead;
      if (got <= 0) return 0; // short read — unreadable, fail-open
      pos += got;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
      let ls = 0, nl;
      while ((nl = data.indexOf(0x0a, ls)) >= 0) {
        const hit = targetOffset(data.subarray(ls, nl), base + ls);
        if (hit !== null) return hit;
        ls = nl + 1;
      }
      base += ls;
      carry = Buffer.from(data.subarray(ls));
    }
    if (carry.length && targetOffset(carry, base) !== null) return base; // final unterminated line
    // Reaching the end means cut is at or past the last chat message — the
    // removed region extends to EOF.
    return base + carry.length;
  } catch {
    return 0;
  } finally {
    try { await fh.close(); } catch {}
  }
}

/**
 * Resolve the effective "to" byte offset for a /sigma/refresh absorption,
 * guarding against post-compaction cut-mapping drift (item 6).
 *
 * `transcriptByteOffsetForMessageIndex` maps the C++ `cut` (a CLIENT message
 * index — the smallest user-message boundary, compute_k_sum) to a transcript
 * byte offset by counting chat entries. That 1:1 mapping holds only while the
 * client's messages array is [system, …all turns…]. After a native compaction
 * the array is rebuilt as [system, summary, …new turns…] while the transcript
 * stays cumulative, so a mapped offset lands BEHIND hist_last_bytes. Left
 * alone, the caller's `toBytes > fromBytes` guard makes that a silent no-op
 * (partial=false) — the LLM strip is quietly disabled post-compaction with no
 * signal that the mapping broke.
 *
 * When the mapped offset is at/behind fromBytes (the drift signature), fall
 * back to the current transcript size: absorb [fromBytes, EOF) — everything
 * new since the last absorb. The removed region post-compaction is a suffix of
 * that new content, so this is a safe superset; over-absorbing kept messages
 * is harmless because mergeStripPatch is a dedup-safe union and
 * hist_last_bytes is monotonic. Returns {toBytes, drift} so the caller can
 * log the drift (item 6 ③ — it was previously undetectable).
 * @param {string} transcriptPath
 * @param {number} cut - the C++ message index
 * @param {number} fromBytes - hist_last_bytes (the "from" offset)
 * @param {{text: string, ordinal?: number}|null} [anchor] - P0-4: the C++
 *   fingerprint of the cut's user message (see anchorNorm / findAnchorOffset)
 * @returns {Promise<{toBytes: number, drift: boolean, map: 'anchor'|'count'|'fail', ordDelta?: number|null}>}
 */
async function resolveAbsorbTo(transcriptPath, cut, fromBytes, anchor) {
  // 1) Anchor first (P0-4): the C++ fingerprint of messages[cut]. An anchor
  // hit is trusted even when off <= fromBytes — that is "already absorbed"
  // (a no-op for the caller), not drift.
  const hit = await findAnchorOffset(transcriptPath, anchor).catch(() => null);
  if (hit) {
    return { toBytes: hit.off, drift: false, map: 'anchor', ordDelta: hit.delta };
  }
  // 2) Legacy entry-counting + drift fallback (unchanged).
  let toBytes = await transcriptByteOffsetForMessageIndex(transcriptPath, cut);
  let drift = false;
  if (cut > 0 && toBytes > 0 && toBytes <= fromBytes) {
    try {
      const size = (await fs.promises.stat(transcriptPath)).size;
      if (size > fromBytes) { toBytes = size; drift = true; }
    } catch { /* unreadable — keep the mapped offset (fail-open) */ }
  }
  return { toBytes, drift, map: toBytes > 0 ? 'count' : 'fail' };
}

// ─── P0-4: anchor mapping (C++ fingerprint → transcript byte offset) ─────

// P0-4: identical rules to C++ sigma_anchor_text (strip injected blocks,
// drop the mid-execution prefix, remove ALL ascii whitespace, first 60 code
// points). The C++ sends the fingerprint of messages[K_sum] (the first
// surviving user message); the JS matches it against user-entry fingerprints
// indexed from the transcript instead of counting entries — counting breaks
// when parallel tool calls pack several C++ messages into one transcript
// entry (one assistant entry with N functionCall parts, one tool_result
// entry with N functionResponse parts).
function anchorNorm(text) {
  let t = stripInjectedBlocks(String(text || ''));
  t = t.replace(/^\s*\[User message received during tool execution\]:/i, '');
  t = t.replace(/[ \t\r\n]+/g, '');
  return Array.from(t).slice(0, 60).join('');
}

// Incremental user-entry index: path -> { scanned, entries: [{off, n}] }.
// The transcript is append-only, so a cached index only re-reads the new
// suffix. A shrunken file (size < scanned) restarts the scan.
const USER_IDX_CACHE = new Map();
const USER_IDX_BUSY = new Map(); // path -> Promise (serialize concurrent scans)
const USER_IDX_MAX_PATHS = CONFIG.USER_IDX_MAX_PATHS;

/**
 * Index one transcript line if it is a user entry with real user text.
 * @param {{scanned: number, entries: Array<{off: number, n: string}>}} c
 * @param {Buffer} lineBuf - the line without its trailing newline
 * @param {number} off - absolute byte offset where the line starts
 * @returns {void}
 */
function indexUserLine(c, lineBuf, off) {
  const s = lineBuf.toString('utf8');
  if (!s.includes('"type":"user"')) return; // measured format: no space (A-1)
  let e;
  try { e = JSON.parse(s); } catch { return; }
  if (e.type !== 'user' || !e.message || !Array.isArray(e.message.parts)) return;
  const texts = e.message.parts
    .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
    .filter((t) => t && !/^User attachment stored on the daemon host/i.test(t.trim()));
  if (!texts.length) return;
  const n = anchorNorm(texts.join(''));
  if (n) c.entries.push({ off, n }); // off = absolute byte offset of the line start
}

/**
 * Scan the transcript for user entries, incrementally from the cached
 * position. Chunked reads (8MB) keep large transcripts bounded; a partial
 * trailing line (no newline yet) is left for the next scan.
 * @param {string} p - transcript path
 * @returns {Promise<{scanned: number, entries: Array<{off: number, n: string}>}>}
 */
async function scanUserIndex(p) {
  const st = await fs.promises.stat(p);
  let c = USER_IDX_CACHE.get(p);
  if (!c || st.size < c.scanned) c = { scanned: 0, entries: [] }; // shrunken → rescan
  if (st.size > c.scanned) {
    const fh = await fs.promises.open(p, 'r');
    try {
      const CHUNK = CONFIG.MAX_LINE_BYTES;
      let pos = c.scanned; // file position of the first unread byte
      let base = c.scanned; // absolute start of the carry (partial line)
      let carry = Buffer.alloc(0);
      while (pos < st.size) {
        const len = Math.min(CHUNK, st.size - pos);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, pos);
        pos += len;
        const data = carry.length ? Buffer.concat([carry, buf]) : buf;
        let ls = 0, nl;
        while ((nl = data.indexOf(0x0a, ls)) >= 0) {
          indexUserLine(c, data.subarray(ls, nl), base + ls);
          ls = nl + 1;
        }
        base += ls;
        carry = Buffer.from(data.subarray(ls)); // tail without newline → re-read
        c.scanned = base; // only complete lines count as scanned
      }
    } finally { await fh.close(); }
  }
  USER_IDX_CACHE.delete(p); USER_IDX_CACHE.set(p, c); // LRU: most recent last
  while (USER_IDX_CACHE.size > USER_IDX_MAX_PATHS) USER_IDX_CACHE.delete(USER_IDX_CACHE.keys().next().value);
  return c;
}

/**
 * Serialize concurrent scans of the same file: a caller joins the in-flight
 * scan instead of racing it (both would read the same suffix).
 * @param {string} p - transcript path
 * @returns {Promise<{scanned: number, entries: Array<{off: number, n: string}>}>}
 */
async function getUserIndex(p) {
  const prev = USER_IDX_BUSY.get(p) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => scanUserIndex(p));
  USER_IDX_BUSY.set(p, next);
  try { return await next; } finally { if (USER_IDX_BUSY.get(p) === next) USER_IDX_BUSY.delete(p); }
}

/**
 * Map an anchor fingerprint to a transcript byte offset (P0-4). Exact
 * fingerprint match against the user-entry index; the ordinal hint breaks
 * ties (closest entry wins, ties → the later one).
 * @param {string} transcriptPath
 * @param {{text: string, ordinal?: number}|null} anchor
 * @returns {Promise<{off: number, delta: number|null}|null>} null = no match
 */
async function findAnchorOffset(transcriptPath, anchor) {
  if (!transcriptPath || !anchor || typeof anchor.text !== 'string' || !anchor.text) return null;
  // Re-normalize the incoming fingerprint (idempotent for the already-
  // normalized C++ fingerprint; makes the match robust if a raw message
  // text ever arrives).
  const want = anchorNorm(anchor.text);
  const c = await getUserIndex(transcriptPath);
  const hits = [];
  for (let i = 0; i < c.entries.length; i++) if (c.entries[i].n === want) hits.push(i);
  if (!hits.length) return null;
  const ord = Number.isInteger(anchor.ordinal) ? anchor.ordinal : -1;
  let best = hits[hits.length - 1]; // no ordinal hint → most recent match
  if (ord >= 0) {
    best = hits.reduce((a, b) => (Math.abs(b - ord) <= Math.abs(a - ord) ? b : a));
  }
  return { off: c.entries[best].off, delta: ord >= 0 ? best - ord : null };
}

/**
 * Cheap stable fingerprint of a Σ block (FNV-1a, 8-hex) — for the C++ to
 * detect a frozen/stale snapshot across requests (plan §5.3). Self-contained
 * (no crypto import needed).
 * @param {string} s
 * @returns {string} 8-hex-char fingerprint
 */
function hashBlock(s) {
  let h = 0x811c9dc5;
  const str = typeof s === 'string' ? s : '';
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Extract the verbatim last user message from a transcript JSONL — the
 * post-compaction ground truth for the current task. Scans the entries from
 * the end and returns the text of the most recent `type === 'user'` entry
 * with real user text parts. Tool results are their own
 * `type: 'tool_result'` entries, so the type filter already excludes them.
 * Two client-side wrappers are stripped so the result is the user's actual
 * words: the `[User message received during tool execution]:` prefix
 * (mid-execution sends) and attachment metadata parts ("User attachment
 * stored on the daemon host..."). The walk streams from EOF (task #17) and
 * extends back as far as needed — the message this hook recovers is the one
 * before the compaction, which can sit hundreds of KB back after a long
 * tool-only stretch — while memory stays bounded (the old full readFileSync
 * allocated O(file)); the hook runs once per compaction, off the per-turn
 * hot path. Fail-open: '' when the transcript has no user entry or is
 * unreadable.
 * @param {string} transcriptPath
 * @param {number} [maxChars=400] - max chars of the returned message
 * @returns {string} verbatim user message (clipped)
 */
function extractLastUserMessage(transcriptPath, maxChars = 400) {
  if (!transcriptPath) return '';
  // Streamed from EOF in 64KB chunks (task #17): the last user message is
  // usually within the first chunk; a long tool-only stretch costs extra
  // chunks, but the heap stays bounded (the old readFileSync allocated O(file)).
  let msg = '';
  walkTranscriptLinesFromEnd(transcriptPath, (line) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    if (entry.type !== 'user' || !entry.message || !Array.isArray(entry.message.parts)) return false;
    // P0-1: strip injected blocks (Σ anchor / system-reminder) from each user
    // part; an injected-blocks-only entry is skipped, so the walk reaches the
    // real last user message.
    const texts = entry.message.parts
      .map((p) => (p && typeof p.text === 'string' ? stripInjectedBlocks(p.text).trim() : ''))
      .filter((t) => t && !/^User attachment stored on the daemon host/i.test(t));
    if (!texts.length) return false; // metadata-only / injected-blocks-only user entry
    msg = texts.join('\n').replace(/^\[User message received during tool execution\]:\s*/i, '');
    return true;
  });
  return msg ? clip(msg, Math.max(100, Number(maxChars) || 400)) : '';
}

module.exports = {
  digestTranscript,
  extractTranscriptTail,
  extractTranscriptDelta,
  extractTranscriptRange,
  ruleHistFromEntries,
  transcriptByteOffsetForMessageIndex,
  resolveAbsorbTo,
  anchorNorm,
  findAnchorOffset,
  hashBlock,
  extractLastUserMessage,
};
