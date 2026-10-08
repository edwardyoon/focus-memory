// Dashboard config management: .env read/write (comment-preserving) + connection tests.
//
// Consumed by index.js dashboard endpoints (port 8891):
//   GET  /api/config      — readConfig()
//   PUT  /api/config      — updateConfig()
//   POST /api/config/test — testConnections()
//
// The .env file is the single config source (dotenv override:true at startup).
// updateConfig() rewrites it in place, preserving comments and ordering of every
// line it does not touch, using the same atomic tmp+rename pattern as hooks/lib/state.js.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = new URL(".", import.meta.url).pathname;

/** .env path — FOCUSMEMORY_ENV_PATH override exists so tests can run against a copy. */
const ENV_PATH = process.env.FOCUSMEMORY_ENV_PATH || path.join(__dirname, "..", ".env");

const KV_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** Error type for validation failures — index.js maps it to HTTP 400. */
export class ConfigError extends Error {}

/**
 * @typedef {object} ConfigField
 * @property {string} key        env var name
 * @property {string} group      UI group id (see CONFIG_GROUPS)
 * @property {string} label      UI label
 * @property {string} type       url | path | string | int | time | enum
 * @property {string} applies    immediate (no restart) | restart (MCP server) | external (other process)
 * @property {string} [note]     when/how the change takes effect
 * @property {boolean} [sensitive] masked in readConfig; empty value on update = keep existing
 * @property {string[]} [enum]   allowed values for type=enum
 * @property {number} [min]      lower bound for type=int
 * @property {string} [default]  shown when the key is set nowhere
 * @property {string} [placeholder]
 */

/** Ordered UI groups for the settings page. */
export const CONFIG_GROUPS = [
  { id: "services", label: "서비스" },
  { id: "llm", label: "LLM" },
  { id: "workspace", label: "워크스페이스" },
  { id: "skillstate", label: "SKILL.state" },
  { id: "gc", label: "Garbage Collection" },
  { id: "runner", label: "러너 / 인증" },
];

const F = (key, group, label, type, extra = {}) => ({ key, group, label, type, ...extra });

/**
 * Whitelist of keys the dashboard may read/write. Anything not listed here is
 * invisible to /api/config (HTTP_PORT, DASHBOARD_PORT, FOCUS_LOG_FILE, timeouts…).
 *
 * `applies` semantics:
 *   immediate — hooks/launchd jobs re-read .env on every run, and the running MCP
 *               process picks the value up on the next request (process.env updated)
 *   restart   — captured into module-level consts at MCP server start → the
 *               qwen-code session (which spawns the MCP server) must be restarted
 *   external  — a separate long-running process (PM2) cached it at its own start
 */
export const CONFIG_FIELDS = [
  F("QDRANT_URL", "services", "Qdrant URL", "url", { applies: "restart", note: "MCP 서버 재시작 필요 (qwen-code 세션)" }),
  F("BGE_URL", "services", "BGE Embedding URL", "url", { applies: "restart", note: "MCP 재시작 필요 — ingest/훅은 다음 실행 시 반영" }),
  F("MEILI_HOST", "services", "Meilisearch Host", "url", { applies: "restart", note: "MCP 서버 재시작 필요" }),
  F("MEILI_INDEX", "services", "Meilisearch Index", "string", { applies: "restart", note: "MCP 서버 재시작 필요" }),
  F("MEILI_MASTER_KEY", "services", "Meilisearch Master Key", "string", { applies: "restart", sensitive: true, note: "MCP 서버 재시작 필요 — 비우면 기존 유지" }),
  F("SEARXNG_URL", "services", "SearXNG URL", "url", { applies: "immediate", note: "MCP 프로세스 즉시 반영" }),
  F("SUMMARY_LLM_URL", "llm", "SUMMARY_LLM URL (chat)", "url", { applies: "restart", note: "MCP 서버 재시작 필요" }),
  F("SUMMARY_LLM_MODEL", "llm", "SUMMARY_LLM Model", "string", { applies: "restart", note: "MCP 서버 재시작 필요" }),
  F("MAIN_LLM", "llm", "MAIN_LLM URL (completions)", "url", { applies: "restart", note: "MCP 재시작 + `pm2 restart task-receiver`" }),
  F("MAIN_LLM_MODEL", "llm", "MAIN_LLM Model", "string", { applies: "restart", note: "MCP 재시작 + `pm2 restart task-receiver`" }),
  F("DOCS_DIR", "workspace", "DOCS_DIR", "path", { applies: "immediate", note: "autoIngest 다음 실행(5분)에 반영" }),
  F("PLANS_DIR", "workspace", "PLANS_DIR", "path", { applies: "immediate", note: "autoIngest 다음 실행(5분)에 반영" }),
  F("TODOS_DIR", "workspace", "TODOS_DIR", "path", { applies: "immediate", note: "대시보드 즉시 — todo-runner/task-receiver는 PM2 재시작 필요" }),
  F("GC_ARCHIVE_DIR", "workspace", "GC Archive Dir", "path", { applies: "immediate", note: "다음 GC 실행(일 1회)에 반영" }),
  F("FOCUSMEMORY_SKILLSTATE", "skillstate", "SKILL.state", "enum", { enum: ["on", "off"], applies: "immediate", note: "훅이 매 이벤트마다 .env를 읽음" }),
  F("FOCUSMEMORY_SKILLSTATE_MAX_CHARS", "skillstate", "추출 창 (chars)", "int", { min: 2000, default: "30000", applies: "immediate", note: "훅이 매 이벤트마다 .env를 읽음" }),
  F("FOCUSMEMORY_SKILLSTATE_CHECKPOINT_INTERVAL", "skillstate", "체크포인트 간격 (tokens)", "int", { min: 1000, default: "50000", applies: "immediate", note: "훅이 매 이벤트마다 .env를 읽음" }),
  F("GC_ENABLED", "gc", "GC 활성화", "enum", { enum: ["on", "off"], applies: "immediate", note: "다음 GC 실행(일 1회)에 반영" }),
  F("GC_TODOS_RETENTION_DAYS", "gc", "Todos 보존 기간 (일)", "int", { min: 1, applies: "immediate", note: "다음 GC 실행(일 1회)에 반영" }),
  F("GC_CHECKPOINT_RETENTION_DAYS", "gc", "Checkpoint 보존 기간 (일)", "int", { min: 1, applies: "immediate", note: "다음 GC 실행(일 1회)에 반영" }),
  F("TODO_RUN_TIME", "runner", "TODO 실행 시각", "time", { applies: "external", note: "`pm2 restart todo-runner` 필요" }),
  F("POSTRUN_TEST_SCRIPT", "runner", "Post-run 테스트 스크립트", "path", { applies: "external", note: "`pm2 restart todo-runner` 필요" }),
  F("DOCS_LANGUAGE", "runner", "Docs 언어", "enum", { enum: ["EN", "KR"], applies: "external", note: "`pm2 restart task-receiver` 필요" }),
  F("CONTEXT_API_TOKEN", "runner", "API Token", "string", { applies: "restart", sensitive: true, note: "MCP 서버 재시작 필요 — 비우면 기존 유지" }),
];

/**
 * Parse raw .env text into ordered entries. Comment/blank/unknown lines are kept
 * verbatim as {kind:"line"}; KEY=VALUE lines become {kind:"kv"} so a rewrite can
 * replace only the values of touched keys and re-serialize byte-identical otherwise.
 * @param {string} text
 * @returns {Array<{kind:"line",text:string}|{kind:"kv",key:string,value:string}>}
 */
export function parseEnv(text) {
  return text.split("\n").map((line) => {
    const m = line.match(KV_RE);
    if (m) return { kind: "kv", key: m[1], value: m[2] };
    return { kind: "line", text: line };
  });
}

/**
 * Serialize entries back to text (round-trips parseEnv exactly).
 * @param {Array<{kind:"line",text:string}|{kind:"kv",key:string,value:string}>} entries
 * @returns {string}
 */
export function serializeEnv(entries) {
  return entries.map((e) => (e.kind === "kv" ? `${e.key}=${e.value}` : e.text)).join("\n");
}

/**
 * Parse .env text into a key→value map (last occurrence wins, like dotenv).
 * @param {string} text
 * @returns {Record<string,string>}
 */
function envTextToMap(text) {
  const map = {};
  for (const line of text.split("\n")) {
    const m = line.match(KV_RE);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

/**
 * Validate one value against its field type.
 * @param {ConfigField} field
 * @param {string} value
 * @returns {string} empty string when valid, otherwise the problem
 */
function validateValue(field, value) {
  switch (field.type) {
    case "url":
      return /^https?:\/\/\S+$/.test(value) ? "" : "http(s):// URL이 필요합니다";
    case "path":
      return value.length > 0 && !value.includes(" ") ? "" : "공백 없는 경로를 입력하세요";
    case "time":
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? "" : "HH:MM (24시제) 형식입니다";
    case "enum":
      return field.enum.includes(value) ? "" : `${field.enum.join(" | ")} 중 하나여야 합니다`;
    case "int":
      if (!/^\d+$/.test(value)) return "음수가 아닌 정수입니다";
      return field.min != null && Number(value) < field.min ? `${field.min} 이상이어야 합니다` : "";
    default: // string
      return value.length > 0 ? "" : "값을 입력하세요";
  }
}

/**
 * Read the current config for the settings page.
 * Value precedence mirrors startup (dotenv override:true): .env file, then
 * process.env, then the schema default. Sensitive values are masked.
 * @returns {Promise<{file:string, groups:object[], fields:object[]}>}
 */
export async function readConfig() {
  const fileText = await fs.readFile(ENV_PATH, "utf-8").catch(() => null);
  const fileVals = fileText ? envTextToMap(fileText) : {};

  const fields = CONFIG_FIELDS.map((f) => {
    const raw = fileVals[f.key] ?? process.env[f.key] ?? f.default ?? "";
    const masked = Boolean(f.sensitive);
    return {
      key: f.key,
      group: f.group,
      label: f.label,
      type: f.type,
      value: masked ? "" : raw,
      hasValue: masked ? Boolean(raw) : undefined,
      isDefault: !(f.key in fileVals) && !(f.key in process.env),
      applies: f.applies,
      note: f.note || "",
      enum: f.enum || null,
      placeholder: f.placeholder || (f.default ? `(기본값 ${f.default})` : ""),
    };
  });

  return { file: ENV_PATH, groups: CONFIG_GROUPS, fields };
}

/**
 * Validate and apply config updates: rewrite .env (atomic, comments preserved)
 * and update the running process.env so per-request readers see the new values.
 * Sensitive keys: an empty value keeps the existing one.
 * @param {Record<string,string>} updates
 * @returns {Promise<{changed: Array<{key:string, applies:string, note:string}>}>}
 * @throws {ConfigError} when any key is not editable or fails validation
 */
export async function updateConfig(updates) {
  if (typeof updates !== "object" || updates === null || Array.isArray(updates)) {
    throw new ConfigError("body는 key/value JSON 객체여야 합니다");
  }
  const byKey = Object.fromEntries(CONFIG_FIELDS.map((f) => [f.key, f]));
  const errors = [];
  const clean = {};
  for (const [key, raw] of Object.entries(updates)) {
    const field = byKey[key];
    if (!field) {
      errors.push(`${key}: 수정 가능한 항목이 아닙니다`);
      continue;
    }
    if (typeof raw !== "string") {
      errors.push(`${key}: 값은 문자열이어야 합니다`);
      continue;
    }
    const value = raw.trim();
    if (field.sensitive && value === "") continue; // keep existing
    const problem = validateValue(field, value);
    if (problem) {
      errors.push(`${key}: ${problem}`);
      continue;
    }
    clean[key] = value;
  }
  if (errors.length) throw new ConfigError(errors.join("; "));
  if (Object.keys(clean).length === 0) return { changed: [] };

  // Skip keys whose value is already the effective value — the settings form
  // submits every non-empty field, so without this diff a no-op save would
  // rewrite the file and report every field as changed.
  const fileText0 = await fs.readFile(ENV_PATH, "utf-8").catch(() => null);
  const current = fileText0 ? envTextToMap(fileText0) : {};
  const diff = {};
  for (const [k, v] of Object.entries(clean)) {
    if ((current[k] ?? process.env[k] ?? "") !== v) diff[k] = v;
  }
  if (Object.keys(diff).length === 0) return { changed: [] };

  const text = await fs.readFile(ENV_PATH, "utf-8");
  const entries = parseEnv(text);
  const applied = new Set();
  for (const e of entries) {
    if (e.kind === "kv" && Object.prototype.hasOwnProperty.call(diff, e.key)) {
      e.value = diff[e.key];
      applied.add(e.key);
    }
  }
  for (const [k, v] of Object.entries(diff)) {
    if (!applied.has(k)) entries.push({ kind: "kv", key: k, value: v });
  }

  const tmp = `${ENV_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, serializeEnv(entries), "utf-8");
  await fs.rename(tmp, ENV_PATH);

  for (const [k, v] of Object.entries(diff)) process.env[k] = v;

  return {
    changed: Object.keys(diff).map((k) => ({ key: k, applies: byKey[k].applies, note: byKey[k].note || "" })),
  };
}

/**
 * Run one connection probe with a timeout; never throws.
 * @param {string} service display name
 * @param {string} url target that was probed
 * @param {() => Promise<string>} probe resolves to a short detail string
 * @param {number} timeoutMs
 * @returns {Promise<{service:string, url:string, ok:boolean, ms:number, detail:string}>}
 */
async function runProbe(service, url, probe, timeoutMs) {
  const t0 = Date.now();
  try {
    const detail = await Promise.race([
      probe(),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (detail === null) return { service, url, ok: false, ms: Date.now() - t0, detail: `timeout (${timeoutMs / 1000}s)` };
    return { service, url, ok: true, ms: Date.now() - t0, detail: detail || "ok" };
  } catch (err) {
    return { service, url, ok: false, ms: Date.now() - t0, detail: err.message || String(err) };
  }
}

/**
 * Probe every configured service, in parallel, using candidate values.
 * `overrides` (the form's current values) win over the running process.env,
 * so the settings page can validate a configuration before saving it.
 * @param {Record<string,string>} [overrides]
 * @returns {Promise<Array<{service:string, url:string, ok:boolean, ms:number, detail:string}>>}
 */
export async function testConnections(overrides = {}) {
  const pick = (key, fallback = "") => (overrides[key] || process.env[key] || fallback || "").trim();

  const qdrantUrl = pick("QDRANT_URL", "http://127.0.0.1:6333");
  const meiliHost = pick("MEILI_HOST", "http://localhost:7700");
  const bgeUrl = pick("BGE_URL", "http://127.0.0.1:8080/v1/embeddings");
  const summaryUrl = pick("SUMMARY_LLM_URL", "http://127.0.0.1:8081/v1/chat/completions");
  const summaryModel = pick("SUMMARY_LLM_MODEL", "summary-27b");
  const mainUrl = pick("MAIN_LLM", summaryUrl);
  const mainModel = pick("MAIN_LLM_MODEL", summaryModel);
  const searxngUrl = pick("SEARXNG_URL", "http://localhost:18080");

  // Same URL derivation as hooks/lib/skillstate.js: MAIN_LLM may point at
  // /v1/completions; the chat endpoint is derived by swapping the suffix.
  const mainChatUrl = /\/chat\/completions$/.test(mainUrl)
    ? mainUrl
    : mainUrl.replace(/\/completions$/, "/chat/completions");

  const llmProbe = (url, model) => async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: "ping", max_tokens: 1, temperature: 0, enable_thinking: false }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.choices?.length) throw new Error("응답에 choices가 없습니다");
    return "응답 ok";
  };

  const results = await Promise.all([
    runProbe("Qdrant", qdrantUrl, async () => {
      const res = await fetch(`${qdrantUrl.replace(/\/$/, "")}/collections`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Qdrant wraps the payload: { result: { collections: [...] }, status, time }
      return `collections ${data.result?.collections?.length ?? "?"}개`;
    }, 6000),
    runProbe("Meilisearch", meiliHost, async () => {
      const res = await fetch(`${meiliHost.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status !== "available") throw new Error(`status: ${data.status}`);
      return "available";
    }, 6000),
    runProbe("BGE Embedding", bgeUrl, async () => {
      const res = await fetch(bgeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "bge-m3", input: "ping" }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const dim = data.data?.[0]?.embedding?.length;
      if (!dim) throw new Error("응답에 embedding이 없습니다");
      return `dim=${dim}`;
    }, 15000),
    runProbe("SUMMARY_LLM", summaryUrl, llmProbe(summaryUrl, summaryModel), 20000),
    runProbe("MAIN_LLM", mainChatUrl, llmProbe(mainChatUrl, mainModel), 20000),
    runProbe("SearXNG", searxngUrl, async () => {
      const u = new URL(`${searxngUrl.replace(/\/$/, "")}/search`);
      u.searchParams.set("q", "test");
      u.searchParams.set("format", "json");
      const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return `results ${data.results?.length ?? 0}개`;
    }, 10000),
  ]);

  return results;
}
