/**
 * Task registration receiver — standalone Express server (port 8888, pm2: task-receiver)
 *
 * Optionally fronted by a reverse proxy (Apache example). A path-less
 * ProxyPass inside a <Location> strips the prefix before forwarding:
 *
 *   <Location /llm-task>
 *       ProxyPass http://<receiver-host>:8888
 *       ProxyPassReverse http://<receiver-host>:8888
 *   </Location>
 *
 * Backend of a login-protected "task registration" admin panel — the panel
 * is the only caller. **fire-and-forget**: POST /receive only acknowledges
 * and responds immediately; a background queue processes tasks serially:
 *   FocusMemory hard gate (business context search)
 *   -> MAIN_LLM (qwen27b) formatting
 *   -> INSERT into udanax.todo_tasks on the 120 master (the 02:00 runner
 *      on the 123 server picks it up; the title suffix keeps the actual
 *      request date, i.e. today)
 *
 * FocusMemory hard gate:
 * - Before the LLM call it ALWAYS searches the same backends as FocusMemory
 *   (Qdrant work_memory & decision_chains, Meilisearch project_facts) to
 *   gather business history / decisions / docs as context.
 * - Direct function calls (clients created inline) — index.js is not a
 *   persistent process, so this avoids depending on HTTP
 *   (/v1/context/search). Env vars are shared with index.js (same .env).
 * - If search is unavailable, it warns and continues without context
 *   (to avoid losing the task).
 *
 * Auth: none — it is the backend of a login-protected admin panel, so
 * exposure is minimal (never expose the port publicly without auth).
 *
 * DOCS_LANGUAGE (.env, default EN):
 * - Language of the generated todos document (date header + item + fallback).
 * - KR  -> the item (title, bullet labels, body) is written in Korean.
 * - EN  -> the item is written in English (default).
 * - The LLM prompt instructions are ALWAYS English; only the generated
 *   document language follows DOCS_LANGUAGE.
 * - The business-context search query is the user's raw text (never
 *   translated). The /toc day labels (어제/오늘/내일) are panel UI chrome and
 *   are intentionally left in Korean.
 *
 * todo_tasks queue convention (shared with the 02:00 runner, todoRunner.js):
 * - Table: udanax.todo_tasks — 120 master (writes) / 121 slave (reads)
 * - title: first `## [ ]` line of the formatted item, prefix stripped
 * - content: the formatted item (or the raw text on LLM failure)
 * - status: pending -> running (runner optimistic lock) -> done | failed
 *   (done only via the agent's finish_task MCP tool)
 * Note: content is free-form Markdown read by the qwen agent, so it is
 * safe to let it follow DOCS_LANGUAGE.
 *
 * ── API usage ────────────────────────────────────────────────────────────
 * Base URL:
 *   - Direct:   http://127.0.0.1:8888   (or http://<receiver-host>:8888)
 *   - Via proxy:  https://<domain>/llm-task   (proxied to the receiver)
 *
 * GET  /ping
 *   - Health check (verify proxy connectivity). No auth.
 *   - 200: { "ok": true, "service": "taskReceiver", "time": "<ISO8601>" }
 *
 * POST /receive
 *   - Register a task (fire-and-forget). No auth. Rate limit: 10 req/min.
 *   - Request body (JSON): { "task": "<raw task text, max 20000 chars>" }
 *   - Responds IMMEDIATELY with the target date (the NEXT day — the 02:00
 *     runner's execution day); formatting + DB insert run in the background
 *     (may take a few minutes).
 *   - 200: { "success": true, "data": { "date": "YYYY-MM-DD", "queued": true } }
 *   - 400 (empty task):  { "success": false, "error": "..." }
 *   - 400 (too long):    { "success": false, "error": "..." }
 *   - 429 (rate limit):  { "success": false, "error": "..." }
 *
 *   Example (local direct):
 *     curl -X POST http://127.0.0.1:8888/receive \
 *       -H 'Content-Type: application/json' \
 *       -d '{"task":"add a weekly digest email feature"}'
 *
 *   Example (via reverse proxy /llm-task):
 *     curl -X POST https://<domain>/llm-task/receive \
 *       -H 'Content-Type: application/json' \
 *       -d '{"task":"add a weekly digest email feature"}'
 *
 * GET  /toc
 *   - Task queue TOC for yesterday/today/tomorrow from udanax.todo_tasks
 *     (121 slave; tomorrow is included because task registration targets
 *     the next day's run). No auth.
 *   - 200: { "success": true, "data": { "days": [
 *           { "date": "YYYY-MM-DD",
 *             "label": "어제" | "오늘" | "내일",
 *             "total": N, "done": M,
 *             "tasks": [ { "id": N,
 *                          "status": "pending" | "running" | "done" | "failed",
 *                          "title": "...", "source": "admin" | "mcp" | "manual",
 *                          "result_summary": "...", "error": "...",
 *                          "finished_at": "..." }, ... ] }, ... ] } }
 *
 * LLM failure fallback: the raw text is inserted as-is as a `## [ ]` item
 * (title = first line) so no task is lost.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const { QdrantClient } = require('@qdrant/js-client-rest');
const { Meilisearch } = require('meilisearch');

/** LLM (MAIN_LLM — high-performance model. FocusMemory/.env MAIN_LLM, completions API) */
const LLM_API = process.env.MAIN_LLM;
const MODEL = process.env.MAIN_LLM_MODEL || 'qwen27b';

/** FocusMemory backends (same env as index.js — for direct hard-gate calls) */
const QDRANT_URL = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
const BGE_URL = process.env.BGE_URL || 'http://127.0.0.1:8080/v1/embeddings';
const MEILI_HOST = process.env.MEILI_HOST || 'http://localhost:7700';
const MEILI_INDEX = process.env.MEILI_INDEX || 'docs_plans';
const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY;

const qdrant = new QdrantClient({ url: QDRANT_URL, timeout: 10000 });
let meiliIndex = null;
if (MEILI_MASTER_KEY) {
    meiliIndex = new Meilisearch({ host: MEILI_HOST, apiKey: MEILI_MASTER_KEY }).index(MEILI_INDEX);
}

/**
 * Document language of the generated todos document (KR | EN). Default EN.
 *
 * Controls the language of:
 *   - the todos file date header (line 1, `# ...`)
 *   - the LLM-generated item (title, bullet labels, body)
 *   - the fallback item (on LLM failure)
 *
 * The LLM prompt instructions themselves are ALWAYS English; only the
 * generated document language follows DOCS_LANGUAGE.
 */
const DOCS_LANGUAGE = (process.env.DOCS_LANGUAGE || 'EN').toUpperCase();
const IS_KR = DOCS_LANGUAGE === 'KR';

const DOC_LANG = {
    /** Human-readable language name used in the LLM output instruction. */
    name: IS_KR ? 'Korean' : 'English',
    /** Todos file date header (line 1). */
    dateHeader: (m, d) => (IS_KR ? `${m}월 ${d}일 해야할 일` : `To-Do List - ${m}/${d}`),
    /** Item title suffix, e.g. "(08/24 user request)". */
    titleSuffix: (md) => (IS_KR ? `(${md} 사용자 요청)` : `(${md} user request)`),
    /** Bullet labels for the item body. */
    labels: IS_KR
        ? {
              requirement: '요구',
              currentState: '현재 상태',
              fixDirection: '수정 방향',
              actionDirection: '실행 방향',
              verification: '검증',
              userDecision: '사용자 결정 필요',
          }
        : {
              requirement: 'Requirement',
              currentState: 'Current state',
              fixDirection: 'Fix direction',
              actionDirection: 'Action direction',
              verification: 'Verification',
              userDecision: 'User decision needed',
          },
    /** Fallback item (LLM failure) default title + note. */
    fallback: IS_KR
        ? { title: '일감 등록', note: '원문 등록 (LLM 정리 실패 — 원문 그대로):' }
        : { title: 'Task registration', note: 'Raw registration (LLM formatting failed - kept as-is):' },
};

/** Listener port (run via pm2 on 8888 — optionally fronted by a reverse proxy) */
const PORT = parseInt(process.env.TASK_RECEIVER_PORT, 10) || 8888;

/** Max length (chars) of the textarea raw text */
const MAX_TASK_LENGTH = 20000;

/** LLM call timeout — fire-and-forget, so no client wait. Generous for thinking models */
const LLM_TIMEOUT_MS = 300000;

/** LLM max_tokens — thinking models use tokens for both reasoning + output, so keep it generous */
const LLM_MAX_TOKENS = 18192;

/**
 * Compute today's date parts in the server local timezone (=KST).
 * @returns {{ymd: string, md: string, header: string}} ymd=YYYY-MM-DD, md=MM-DD, header=date title per DOCS_LANGUAGE
 */
function todayDateParts() {
    const now = new Date();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return {
        ymd: `${now.getFullYear()}-${m}-${d}`,
        md: `${m}-${d}`,
        header: DOC_LANG.dateHeader(m, d)
    };
}

/**
 * Compute tomorrow's date parts in the server local timezone (=KST).
 * Task registration targets the NEXT day's plan file — the 06:00 backlog
 * run (todoRunner.js) picks it up in the early morning.
 * @returns {{ymd: string, md: string, header: string}} ymd=YYYY-MM-DD, md=MM-DD, header=date title per DOCS_LANGUAGE
 */
function tomorrowDateParts() {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return {
        ymd: `${t.getFullYear()}-${m}-${d}`,
        md: `${m}-${d}`,
        header: DOC_LANG.dateHeader(m, d)
    };
}

// ── FocusMemory hard gate — business context search ──────────────────────

/**
 * Send text to the BGE-M3 embedding server and fetch the vector.
 * (Same call as index.js embed() — FocusMemory/.env BGE_URL)
 * @param {string} text - text to embed
 * @returns {Promise<number[]|null>} the vector, or null on failure
 */
async function embed(text) {
    const res = await axios.post(BGE_URL, { model: 'bge-m3', input: text }, { timeout: 10000 });
    const data = res.data;
    if (data.data && Array.isArray(data.data) && data.data[0]) {
        return data.data[0].embedding;
    }
    if (data.embedding) {
        return data.embedding;
    }
    return null;
}

/**
 * Format a search result into a compact context block.
 * @param {{score: number, payload: object}} r - normalized search result
 * @param {string} collection - source collection (work_memory|decision_chains|project_facts)
 * @returns {string} context entry (title + truncated detail/content)
 */
function formatContextEntry(r, collection) {
    const p = r.payload || {};
    if (collection === 'project_facts') {
        const title = String(p.summary_text || '').slice(0, 120);
        return `[project_facts] ${p.source_doc || ''} — ${title}\n  ${String(p.content || '').slice(0, 300)}`;
    }
    // work_memory / decision_chains
    const files = (p.related_files || []).slice(0, 3).join(', ');
    return `[${collection}] ${p.summary_text || '(untitled)'}\n  ${String(p.detail || '').slice(0, 300)}${files ? `\n  files: ${files}` : ''}`;
}

/**
 * FocusMemory hard gate — search business context using the raw text.
 *
 * Directly calls the same backends as index.js doSearch() (index.js is not a
 * persistent process, so clients are created inline instead of HTTP):
 * - Qdrant: work_memory, decision_chains (vector top 5)
 * - Meilisearch: project_facts (docs/plans full-text top 5)
 * - graph/code_chunks: skipped (low context value for todo formatting)
 * Scoring matches lib/utils.js rerankMerged() (intent-aware backend weights +
 * work_memory recency decay). Returns '' if search is unavailable — the process
 * continues without context (to avoid losing the task).
 *
 * @param {string} task - raw textarea text
 * @returns {Promise<string>} context block ('' if no results)
 */
async function fetchBusinessContext(task) {
    try {
        const vector = await embed(task);
        if (!vector) {
            console.warn('[taskReceiver] embedding failed - continuing without business context');
            return '';
        }

        const [wmRes, dcRes, meiliRes] = await Promise.all([
            qdrant.query('work_memory', { query: vector, limit: 5, with_payload: true })
                .then(r => (r.points || []).map(p => ({ score: p.score ?? 0, payload: p.payload, _collection: 'work_memory' })))
                .catch(e => { console.warn('[taskReceiver] work_memory search failed:', e.message); return []; }),
            qdrant.query('decision_chains', { query: vector, limit: 5, with_payload: true })
                .then(r => (r.points || []).map(p => ({ score: p.score ?? 0, payload: p.payload, _collection: 'decision_chains' })))
                .catch(e => { console.warn('[taskReceiver] decision_chains search failed:', e.message); return []; }),
            meiliIndex
                ? meiliIndex.search(task, { limit: 5, attributesToRetrieve: ['title', 'content', 'filepath', 'source', 'uid'] })
                    .then(res => (res.hits || []).map(h => ({
                        score: 0.85,
                        payload: {
                            source_doc: h.filepath,
                            content: `${h.title}\n${h.content}`,
                            summary_text: h.title
                        },
                        _collection: 'project_facts'
                    })))
                    .catch(e => { console.warn('[taskReceiver] project_facts search failed:', e.message); return []; })
                : Promise.resolve([])
        ]);

        // Intent-aware weights, kept in sync with lib/utils.js rerankMerged():
        // decision-style queries (causal/temporal, non-knowledge) rank decision_chains
        // above planning docs; everything else keeps project_facts 1.3 / decision_chains 1.1.
        let backendWeights = { project_facts: 1.3, decision_chains: 1.1, work_memory: 1.0 };
        try {
            const { extractQueryFeatures } = await import('./lib/utils.js');
            const features = extractQueryFeatures(task);
            const isDecisionQuery = Boolean((features.is_causal || features.is_temporal) && !features.is_knowledge);
            if (isDecisionQuery) {
                backendWeights = { decision_chains: 1.3, work_memory: 1.2, project_facts: 1.0 };
            }
        } catch {
            // extractQueryFeatures unavailable — fall back to default weights
        }
        // work_memory recency decay (30-day half-life) — timestamp-less backends (e.g. project_facts) get a neutral 0.5
        const now = Date.now();
        const DAY_MS = 86400000;
        const merged = [...wmRes, ...dcRes, ...meiliRes]
            .map(r => {
                let recencyScore = 0.5;
                const ts = r.payload.timestamp || r.payload.ingested_at;
                if (ts) {
                    const ageDays = (now - new Date(ts).getTime()) / DAY_MS;
                    recencyScore = Math.exp(-ageDays / 30);
                }
                return { ...r, weighted: (r.score || 0) * (backendWeights[r._collection] ?? 1.0) * recencyScore };
            })
            .sort((a, b) => b.weighted - a.weighted)
            .slice(0, 5);

        if (merged.length === 0) return '';
        return merged.map((r, i) => `${i + 1}. ${formatContextEntry(r, r._collection)}`).join('\n');
    } catch (e) {
        console.warn('[taskReceiver] business context search failed - continuing without context:', e.message);
        return '';
    }
}

/**
 * Build the prompt that asks the LLM to format the raw task into a todos item.
 * The instructions are always English; the OUTPUT language follows DOCS_LANGUAGE.
 * @param {string} rawTask - raw textarea text
 * @param {string|null} existingContent - existing next-day file content (style reference)
 * @param {{ymd: string, md: string}} dateParts - target file date (next day; md = actual request date, today)
 * @param {string} context - FocusMemory hard-gate search context ('' if none)
 * @returns {string} prompt
 */
function buildFormatPrompt(rawTask, existingContent, dateParts, context) {
    const L = DOC_LANG.labels;
    return `You are an assistant that maintains a daily task todos Markdown file.
An administrator registered a task for the next day as unstructured text.
Format it into a **single item** to append to the todos file.

[Existing todos file for the next day] (filename: ${dateParts.ymd}.md)
${existingContent ? existingContent : '(new file - no items yet)'}

[Raw text registered by the administrator]
${rawTask}

[Business context (FocusMemory search)] (reference material to make the title/direction concrete - do NOT copy the context itself into the output item)
${context || '(no search results - format from the raw text only)'}

[Formatting rules - you MUST follow these]
1. Output exactly ONE item starting with \`## [ ]\`. A new item is always in the not-started state \`[ ]\`.
2. Title format: \`## [ ] <concise title> ${DOC_LANG.titleSuffix(dateParts.md)}\` - the title summarizes the core in at most 40 characters.
3. After a blank line under the title, build the body with bullets (\`- \`):
   - **${L.requirement}**: what was requested
   - **${L.currentState}**: only if the raw text has current status/investigation results
   - **${L.fixDirection}** (or **${L.actionDirection}**): concrete steps - preserve technical details from the raw text as-is (file paths, APIs, commands, table names, etc.); no omission, distortion, or invention
   - **${L.verification}**: only if mentioned in the raw text or self-evident
   - If there are multiple steps, list them with indented step numbers (\`  1.\` \`  2.\`)
4. If the raw text contains items requiring a user decision, list them under a **${L.userDecision}** section.
5. If the title duplicates an existing item in the file, add the target (file/feature name) to the title to distinguish it.
6. Output NOTHING besides the item - no explanations, comments, or code fences (\`\`\`) are allowed.

[Output language]
Write the entire item (title and all bullet bodies) in ${DOC_LANG.name}.

Output the formatted item directly:`;
}

/**
 * Extract only the todos item block from the LLM response.
 *
 * Thinking models on the completions path mix reasoning into the body, and
 * sometimes quote the prompt's format example (`## [ ] <title>`) mid-way.
 * So when there are multiple line-start `## [ ]` blocks, take the LAST one
 * (= the final answer).
 *
 * @param {string} raw - LLM text response
 * @returns {string|null} the item block starting with `## [ ]`, or null if parsing fails
 */
function extractItemBlock(raw) {
    if (!raw) return null;

    let text = raw.trim();

    // Strip any </think> leftovers
    text = text.replace(/<\/?think>/gi, '');
    text = text.replace(/think[\s\S]*?\/?think>/gi, '').trim();

    // Strip code fences
    if (text.startsWith('```')) {
        text = text.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
    }

    // Last line-start `## [ ]` block position — discard everything before it (reasoning/example quotes)
    const starts = [];
    const re = /^##\s+\[[ x~!]\]/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
        starts.push(m.index);
    }
    if (starts.length === 0) return null;
    text = text.slice(starts[starts.length - 1]);

    return text.trim();
}

/**
 * Ask the LLM to generate the todos item.
 *
 * completions API (MAIN_LLM) — llama.cpp /v1/completions format (prompt field,
 * response choices[0].text). enable_thinking is ignored if the server does not
 * support it. max_tokens stays generous (relative to thinking + long raw text).
 * If the response content is empty, the worker falls back to the raw text.
 *
 * @param {string} prompt - format prompt
 * @returns {Promise<{content: string, finishReason: string|null, usage: object|null}>} response info
 */
async function callLLM(prompt) {
    const response = await axios.post(LLM_API, {
        model: MODEL,
        prompt: prompt,
        temperature: 0.3,
        top_p: 0.9,
        max_tokens: LLM_MAX_TOKENS,
        enable_thinking: false
    }, { timeout: LLM_TIMEOUT_MS });

    const choice = response.data?.choices?.[0];
    return {
        content: typeof choice?.text === 'string' ? choice.text : '',
        finishReason: choice?.finish_reason || null,
        usage: response.data?.usage || null
    };
}

/**
 * Fallback for LLM failure — format the raw text as a todos item as-is.
 * @param {string} rawTask - raw text
 * @param {{md: string}} dateParts - date parts (md = actual request date, today)
 * @returns {string} todos item block
 */
function buildFallbackItem(rawTask, dateParts) {
    // Use the first line as the title (truncate to 60 chars)
    const firstLine = rawTask.split('\n').map(s => s.trim()).find(s => s) || DOC_LANG.fallback.title;
    const title = firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;

    const indented = rawTask
        .split('\n')
        .map(line => line.trim() ? '  ' + line : '')
        .join('\n');

    return `## [ ] ${title} ${DOC_LANG.titleSuffix(dateParts.md)}\n\n- **${DOC_LANG.fallback.note}**\n\n${indented}`;
}

// ── fire-and-forget background queue ─────────────────────────────

/**
 * Format the raw task with the LLM, then INSERT it into udanax.todo_tasks
 * (background, serial). FocusMemory hard-gate context -> MAIN_LLM -> INSERT.
 * Even on LLM failure, insert the raw-text fallback so no task is lost.
 * @param {string} task - raw text
 */
async function processTask(task) {
    // Tasks are planned for the NEXT day (the 02:00 runner on 123), not today.
    // The title suffix keeps the actual request date (today).
    const requestParts = todayDateParts();
    const targetParts = tomorrowDateParts();
    const dateParts = { ...targetParts, md: requestParts.md };

    let item;
    let usedLlm = false;

    // FocusMemory hard gate — always search business context before the LLM (continue without context if unavailable)
    const context = await fetchBusinessContext(task);
    console.log(`[taskReceiver] business context ${context ? `loaded (${context.length} chars)` : 'none'}`);

    try {
        const prompt = buildFormatPrompt(task, null, dateParts, context);
        const { content, finishReason, usage } = await callLLM(prompt);
        const extracted = extractItemBlock(content);
        usedLlm = Boolean(extracted);
        console.log(`[taskReceiver] LLM call complete: finish=${finishReason}, usage=${JSON.stringify(usage || {})}`);

        item = extracted || buildFallbackItem(task, dateParts);
        if (!usedLlm) {
            console.warn('[taskReceiver] LLM formatting failed - raw fallback (content=' + (content ? JSON.stringify(content.slice(0, 100)) : '∅') + ')');
        }
    } catch (e) {
        console.error('[taskReceiver] LLM call failed - raw fallback:', e.message);
        item = buildFallbackItem(task, dateParts);
    }

    // Title = first `## [ ]` line of the item, prefix stripped
    const firstLine = (item.split('\n').find((l) => l.trim()) || '').trim();
    const m = firstLine.match(/^##\s+\[[ x~!]\]\s*(.+)/);
    const title = (m ? m[1] : firstLine).trim() || DOC_LANG.fallback.title;

    const { insertTask } = await import('./lib/taskdb.js');
    const { id } = await insertTask({ title, content: item, rawText: task, source: 'admin', scheduledDate: targetParts.ymd });

    console.log(`[taskReceiver] task inserted: id=${id} (llm=${usedLlm}, title=${title}, scheduled=${targetParts.ymd})`);
}

let taskQueue = Promise.resolve();

/**
 * Enqueue a task into the background queue (serial processing — bounds LLM
 * cost to one formatting call at a time).
 * @param {string} task - raw text
 */
function enqueueTask(task) {
    taskQueue = taskQueue
        .then(() => processTask(task))
        .catch(e => console.error('[taskReceiver] queue processing failed:', e));
}

// ── Express app ──────────────────────────────────────────────

const app = express();

app.use(express.json({ limit: '256kb' }));
// Allow CORS so a browser on the same host can call 127.0.0.1:8888 directly.
// Requests arriving via the reverse-proxy path are same-origin, so CORS is not needed there.
app.use(cors());

// A reverse proxy sends X-Forwarded-For, so trust one hop —
// otherwise express-rate-limit v7 throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and
// /receive over the proxied path returns 500 (direct local calls are unaffected).
app.set('trust proxy', 1);

/**
 * LLM-cost protection limiter — 10 per minute, dedicated to this standalone server.
 */
const receiverLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests. Please try again later.' }
});

/**
 * GET /ping — health check (for verifying proxy connectivity, no auth)
 */
app.get('/ping', (req, res) => {
    res.json({ ok: true, service: 'taskReceiver', time: new Date().toISOString() });
});

/**
 * POST /receive — fire-and-forget
 * Enqueue the raw task and respond immediately.
 * FocusMemory context search + LLM formatting + DB insert run in the background.
 */
app.post('/receive', receiverLimiter, (req, res) => {
    const task = typeof req.body?.task === 'string' ? req.body.task.trim() : '';

    if (!task) {
        return res.status(400).json({ success: false, error: 'Please enter the task content.' });
    }
    if (task.length > MAX_TASK_LENGTH) {
        return res.status(400).json({ success: false, error: `Task content is too long (max ${MAX_TASK_LENGTH} chars).` });
    }

    enqueueTask(task);

    // Target date = the NEXT day's run (matches processTask)
    const dateParts = tomorrowDateParts();
    res.json({
        success: true,
        data: {
            date: dateParts.ymd,
            queued: true
        }
    });
});

/**
 * GET /toc — yesterday/today/tomorrow task queue TOC from udanax.todo_tasks
 * (121 slave — tomorrow is included because task registration targets the
 * next day's run)
 */
app.get('/toc', async (req, res) => {
    const fmt = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();
    const todayStr = fmt(today);
    const yest = new Date(today);
    yest.setDate(yest.getDate() - 1);
    const yestStr = fmt(yest);
    const tmrw = new Date(today);
    tmrw.setDate(tmrw.getDate() + 1);
    const tmrwStr = fmt(tmrw);

    try {
        const { listTasks } = await import('./lib/taskdb.js');
        const days = [];
        for (const dateStr of [yestStr, todayStr, tmrwStr]) {
            const rows = await listTasks({ from: dateStr, to: dateStr });
            days.push({
                date: dateStr,
                label: dateStr === todayStr ? '오늘' : dateStr === yestStr ? '어제' : '내일',
                total: rows.length,
                done: rows.filter((r) => r.status === 'done').length,
                tasks: rows.map((r) => ({
                    id: r.id,
                    status: r.status,
                    title: r.title,
                    source: r.source,
                    result_summary: r.result_summary,
                    error: r.error,
                    finished_at: r.finished_at
                }))
            });
        }
        res.json({ success: true, data: { days: days.reverse() } });
    } catch (e) {
        console.error('[taskReceiver] /toc failed:', e.message);
        res.status(500).json({ success: false, error: `Failed to load the task queue: ${e.message}` });
    }
});

app.listen(PORT, () => {
    console.log(`[taskReceiver] task receiver running - port ${PORT}, queue: udanax.todo_tasks (master ${process.env.TASK_DB_HOST || '192.168.219.120'} / slave ${process.env.TASK_DB_SLAVE_HOST || process.env.TASK_DB_HOST || '192.168.219.120'}), llm: ${LLM_API || '(MAIN_LLM not set!)'}, docs_lang: ${DOCS_LANGUAGE}`);
});
