#!/usr/bin/env node
/**
 * todoRunner.js — Scheduled TODO execution runner (PM2-managed, DB queue mode).
 *
 * Runs daily (default 02:00, configurable via TODO_RUN_TIME in FocusMemory/.env).
 * The queue is the udanax.todo_tasks table (120 master write / 121 slave read,
 * lib/taskdb.js) — tasks are registered by the admin panel (taskReceiver),
 * the put_task MCP tool, or manual INSERT.
 *
 * Nightly cycle:
 * 1. fetchPendingTasks() — status='pending' AND scheduled_date <= CURDATE()
 *    (catch-up built in), capped at TODO_NIGHT_LIMIT (default 10).
 * 2. Per task (sequential):
 *    a. markRunning(id) — optimistic lock (pending→running); skip if lost the race.
 *    b. Spawn qwen with the task content + git/PR protocol + finish_task protocol.
 *    c. Post-run verification: re-read the task from the MASTER. If it is still
 *       'running' (the agent never called finish_task), force 'failed' with a
 *       reason: exit≠0 → "qwen exit <code>: <log tail>"; exit=0 →
 *       "no completion record"; timeout → "timeout (<min> min)" + 20-line log tail.
 *       The runner NEVER marks 'done' — only the agent's finish_task can.
 * 3. Optional post-run verification script (POSTRUN_TEST_SCRIPT) — runs ONCE,
 *    only when EVERY task in the batch ended 'done'.
 * 4. Optional FocusMemory auto-ingest (AUTO_INGEST, default on; set off on 123
 *    where the shared index is maintained by the local Mac).
 *
 * Flags:
 *   --dry-run  list pending tasks (DB query only — no qwen, no state write)
 *   --now      run one cycle immediately, then continue the schedule
 *
 * Env (FocusMemory/.env):
 *   TASK_DB_HOST / TASK_DB_SLAVE_HOST / TASK_DB_USER / TASK_DB_PASS / TASK_DB_NAME
 *   TODO_RUN_TIME     24h HH:MM (default 02:00)
 *   TODO_NIGHT_LIMIT  max tasks per night (default 10)
 *   TASK_TIMEOUT_MIN  per-task qwen timeout in minutes (default 120)
 *   AUTO_INGEST       on|off — run autoIngest.js after the batch (default on)
 *   QWEN_BIN          qwen CLI path (default /opt/homebrew/bin/qwen;
 *                     123: /home/edwardyoon/.local/bin/qwen)
 *   POSTRUN_TEST_SCRIPT  optional verification script (see .env.example)
 */

import { spawn } from "child_process";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as taskdb from "./lib/taskdb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load FocusMemory/.env (existing process env wins over file values).
dotenv.config({ path: path.join(__dirname, ".env") });

const WORKSPACE = path.resolve(__dirname, "..");
const LOG_DIR = "/tmp/focus-memory";
const FOCUSMEMORY_DIR = __dirname;
const STATE_FILE = path.join(FOCUSMEMORY_DIR, "todo_runner_state.json");

const QWEN_BIN = process.env.QWEN_BIN || "/opt/homebrew/bin/qwen";
const NIGHT_LIMIT = Math.max(1, parseInt(process.env.TODO_NIGHT_LIMIT || "10", 10));
const TASK_TIMEOUT_MIN = Math.max(5, parseInt(process.env.TASK_TIMEOUT_MIN || "120", 10));
const AUTO_INGEST = (process.env.AUTO_INGEST || "on").toLowerCase() !== "off";

// ─── Instructions (injected into every execution prompt) ───

/**
 * Build the standing instructions for the nightly qwen agent — workspace
 * location, the git/PR protocol (runner branch from origin/main, PR via gh),
 * production-safety and DB read/write rules, and the finish_task mandate.
 * @returns {string} instruction block
 */
function buildInstructions() {
  const masterHost = process.env.TASK_DB_HOST || "192.168.219.120";
  const slaveHost = process.env.TASK_DB_SLAVE_HOST || masterHost;
  return `CRITICAL INSTRUCTIONS (nightly autonomous run):
- Workspace: ${WORKSPACE} — one git repository per project directory.
- You are executing ONE task from the todo_tasks queue (the task id is in the prompt below).
- Git/PR protocol (MANDATORY for any code change):
  1. In each repository you modify: git fetch origin, then branch from origin/main:
     git checkout -b runner/<YYYYMMDD> origin/main   (YYYYMMDD = today)
  2. Commit per logical change with clear messages. NEVER commit to or push main/master.
  3. When the work is done: git push -u origin runner/<YYYYMMDD>, then create a PR
     with the gh CLI: gh pr create (Korean title/body is fine).
- Production safety: do NOT restart or modify services on the 120-124 servers
  (Apache, pm2, docker). Code changes go out via PR only.
- Database: writes to the master (${masterHost}) only; the slave (${slaveHost}) is READ-ONLY.
- Completion: when the task is finished AND verified, you MUST call the finish_task
  MCP tool EXACTLY ONCE (see the completion protocol below). If you cannot finish,
  still call finish_task with status="failed" before exiting — never exit silently.`;
}

// ─── Helpers ──────────────────────────────────────────────

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Local date string (YYYY-MM-DD), shifted back by N days.
 * @param {number} [daysAgo=0]
 * @returns {string}
 */
function dateStr(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Last N non-empty lines of a log file (for the failed-fallback error text).
 * @param {string} logPath
 * @param {number} [n=20]
 * @returns {string} tail text, or "" if the log is missing
 */
function logTail(logPath, n = 20) {
  try {
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter((l) => l.trim());
    return lines.slice(-n).join("\n");
  } catch {
    return "";
  }
}

/**
 * Record the run outcome for error tracking (last run + rolling 30).
 * @param {object} record
 * @returns {void}
 */
function saveState(record) {
  let state = { consecutiveFailures: 0, history: [] };
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    // first run — start fresh
  }
  const bad = (record.failed || 0) + (record.error ? 1 : 0);
  state.consecutiveFailures = bad > 0 ? (state.consecutiveFailures || 0) + 1 : 0;
  state.lastRun = record;
  state.history = [...(state.history || []), record].slice(-30);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Spawn a child process, tee stdout+stderr into a log file, wait for exit.
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} logPath
 * @param {string} [cwd]
 * @param {object} [env]
 * @param {number} [timeoutMs] 0 = no timeout; otherwise SIGKILL at the deadline
 * @returns {Promise<{code: number, timedOut: boolean}>} exit code + timeout flag
 */
function runProcess(cmd, args, logPath, cwd, env, timeoutMs = 0) {
  return new Promise((resolve) => {
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.write(`\n=== ${cmd} ${args.join(" ")} ===\n`);

    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd: cwd || WORKSPACE,
      env: env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            logStream.write(`\n=== timeout after ${Math.round(timeoutMs / 60000)} min — SIGKILL ===\n`);
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;

    child.stdout.on("data", (chunk) => {
      logStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      logStream.write(chunk);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      logStream.end(`\n=== exit code: ${code} ===\n`);
      resolve({ code: code ?? 1, timedOut });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      logStream.write(`\n=== spawn error: ${err.message} ===\n`);
      logStream.end();
      resolve({ code: 1, timedOut });
    });
  });
}

/**
 * Build the env for qwen: explicit PATH (~/.local/bin + /opt/homebrew/bin)
 * and the qwen project dir derived from the workspace path.
 * @returns {object} env object
 */
function buildQwenEnv() {
  const home = process.env.HOME || "";
  const extraPath = [path.join(home, ".local", "bin"), "/opt/homebrew/bin", process.env.PATH || "/usr/bin:/bin"]
    .filter(Boolean)
    .join(":");
  return {
    ...process.env,
    PATH: extraPath,
    QWEN_CODE_PROJECT_DIR: path.join(home, ".qwen", "projects", WORKSPACE.replace(/\//g, "-")),
  };
}

/**
 * Run the optional post-run verification script (POSTRUN_TEST_SCRIPT in
 * FocusMemory/.env, absolute or workspace-relative). Invoked exactly once
 * per runTodo cycle — never per task — and only after ALL tasks ended done.
 * On failure, one fix round is delegated to qwen (with the failure log),
 * then the script is re-run as the independent arbiter.
 * @param {string} logPath
 * @param {object} env qwen spawn env (PATH/QWEN_CODE_PROJECT_DIR)
 * @returns {Promise<object|null>} result record, or null when not configured
 */
async function runPostRunTest(logPath, env) {
  const script = (process.env.POSTRUN_TEST_SCRIPT || "").trim();
  if (!script) return null;
  const scriptPath = path.isAbsolute(script) ? script : path.resolve(WORKSPACE, script);
  if (!fs.existsSync(scriptPath)) {
    log(`Post-run verification: script not found (${scriptPath}) — skipped.`);
    return { configured: true, ran: false, passed: false, fixed: false, reason: "script not found" };
  }

  const startedAt = Date.now();
  log("Post-run verification: running script...");
  const first = await runProcess("bash", [scriptPath], logPath, WORKSPACE);

  if (first.code === 0) {
    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    log(`Post-run verification: PASSED (${durationSec}s)`);
    return { configured: true, ran: true, passed: true, fixed: false, exitCode: 0, durationSec };
  }

  log(`Post-run verification: FAILED (exit ${first.code}) — delegating one fix round to qwen...`);
  const fixPrompt = `${buildInstructions()}

The post-run verification script failed after the TODO batch completed.
Script: ${scriptPath}
Its full output is appended to: ${logPath} (see the last "bash ${scriptPath}" section).

Diagnose the failing tests and fix the workspace code. Then re-run the script
yourself and confirm it exits 0. Do NOT modify the verification script itself
unless a test is objectively wrong — if you do, explain why.`;
  const fix = await runProcess(QWEN_BIN, ["-p", fixPrompt], logPath, WORKSPACE, env);
  log(`Post-run verification: fix round exited with code ${fix.code} — re-running script to verify...`);
  const re = await runProcess("bash", [scriptPath], logPath, WORKSPACE);
  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  if (re.code === 0) {
    log(`Post-run verification: PASSED after fix round (${durationSec}s)`);
    return { configured: true, ran: true, passed: true, fixed: true, exitCode: 0, durationSec };
  }
  log(`Post-run verification: still FAILED after fix round (exit ${re.code}) — leaving for user review.`);
  return { configured: true, ran: true, passed: false, fixed: true, exitCode: re.code, durationSec };
}

// ─── Main execution ───────────────────────────────────────────────

/**
 * Execute one queued task: optimistic lock → qwen → master verification →
 * failed fallback (the runner never marks done).
 * @param {object} task row from fetchPendingTasks (id, title, content, source, scheduled_date)
 * @param {string} today YYYY-MM-DD (log file naming)
 * @returns {Promise<object>} result record
 */
async function runTask(task, today) {
  const logPath = path.join(LOG_DIR, `${today}-task-${task.id}.log`);
  const startedAt = Date.now();

  const locked = await taskdb.markRunning(task.id);
  if (!locked) {
    log(`task ${task.id}: lost the pending→running race — skipped`);
    return { id: task.id, title: task.title, status: "skipped", exitCode: null, timedOut: false, durationSec: 0, error: "lost lock" };
  }

  log(`task ${task.id}: running — "${task.title}"`);

  const prompt = `${buildInstructions()}

## Task (id=${task.id}, source=${task.source}, scheduled ${task.scheduled_date})
Title: ${task.title}

${task.content}

## Completion protocol (MANDATORY)
When you are done, call the finish_task MCP tool EXACTLY ONCE:
- success: finish_task(task_id=${task.id}, status="done", result_summary="<PR URL(s), commit hash(es), verification result>")
- failure: finish_task(task_id=${task.id}, status="failed", error="<what failed — prefix 'BLOCKED: ' if you are stuck>")
This is the ONLY way the task is marked done. If you exit without calling
finish_task, the runner will mark the task failed.`;

  const { code, timedOut } = await runProcess(
    QWEN_BIN,
    ["-p", prompt],
    logPath,
    WORKSPACE,
    buildQwenEnv(),
    TASK_TIMEOUT_MIN * 60000,
  );
  log(`task ${task.id}: qwen exited with code ${code}${timedOut ? " (TIMEOUT)" : ""}`);

  // Post-run verification — MASTER read (fresh, no replication lag).
  let final = null;
  try {
    final = await taskdb.getTask(task.id);
  } catch (err) {
    log(`task ${task.id}: post-run DB read failed: ${err.message}`);
  }

  if (final && final.status === "running") {
    // The agent never called finish_task — force failed (runner never marks done).
    const reason = timedOut
      ? `timeout (${TASK_TIMEOUT_MIN} min)\n--- log tail ---\n${logTail(logPath, 20)}`
      : code !== 0
        ? `qwen exit ${code}${logTail(logPath, 10) ? `:\n${logTail(logPath, 10)}` : ""}`
        : "no completion record (agent exited 0 without calling finish_task)";
    try {
      await taskdb.updateResult(task.id, { status: "failed", error: reason });
      final = { ...final, status: "failed", error: reason };
      log(`task ${task.id}: marked failed — ${reason.split("\n")[0]}`);
    } catch (err) {
      log(`task ${task.id}: failed to record fallback error: ${err.message}`);
    }
  }

  return {
    id: task.id,
    title: task.title,
    status: final ? final.status : "unknown",
    exitCode: code,
    timedOut,
    durationSec: Math.round((Date.now() - startedAt) / 1000),
    error: final && final.error ? final.error : null,
    result: final && final.result_summary ? final.result_summary : null,
  };
}

/**
 * Execute the nightly batch: fetch pending → run each task sequentially →
 * post-run verification (all-done only) → auto-ingest → record outcome.
 * @param {string} [trigger="schedule"] "schedule" | "manual"
 * @returns {Promise<void>}
 */
async function runTodo(trigger = "schedule") {
  ensureLogDir();
  const today = dateStr(0);

  let tasks = [];
  try {
    tasks = await taskdb.fetchPendingTasks({ limit: NIGHT_LIMIT });
  } catch (err) {
    log(`ERROR: failed to fetch pending tasks: ${err.message}`);
    saveState({ at: new Date().toISOString(), trigger, date: today, total: 0, done: 0, failed: 0, error: `fetch failed: ${err.message}`, tasks: [] });
    return;
  }

  if (tasks.length === 0) {
    log(`No pending tasks (scheduled_date <= ${today}). Nothing to do.`);
    return;
  }

  log(`--- Todo runner: ${tasks.length} task(s) (trigger: ${trigger}) ---`);
  const qwenEnv = buildQwenEnv();
  const records = [];
  for (const task of tasks) {
    try {
      records.push(await runTask(task, today));
    } catch (err) {
      log(`task ${task.id}: unexpected error: ${err.message}`);
      records.push({ id: task.id, title: task.title, status: "error", exitCode: null, timedOut: false, durationSec: 0, error: err.message });
    }
  }

  const done = records.filter((r) => r.status === "done").length;
  const failed = records.filter((r) => r.status === "failed").length;
  log(`--- Batch complete: ${done} done, ${failed} failed, ${records.length - done - failed} other ---`);

  // Post-run verification script — ONCE, only when EVERY task ended done.
  let postRun = null;
  if (records.length > 0 && done === records.length) {
    postRun = await runPostRunTest(path.join(LOG_DIR, `${today}-postrun.log`), qwenEnv);
  }

  // Auto-ingest (shared vector index — off on 123, maintained by the local Mac).
  if (AUTO_INGEST) {
    log("Triggering auto-ingest...");
    const ingest = await runProcess("node", ["autoIngest.js"], path.join(LOG_DIR, `${today}-ingest.log`), FOCUSMEMORY_DIR);
    log(`auto-ingest exited with code ${ingest.code}`);
  }

  saveState({
    at: new Date().toISOString(),
    trigger,
    date: today,
    total: records.length,
    done,
    failed,
    tasks: records,
    postRun,
  });
}

// ─── Scheduler ────────────────────────────────────────────────────

const DEFAULT_RUN_TIME = "02:00"; // 24h "HH:MM" — TODO_RUN_TIME 미설정/오류 시 폴백

/**
 * Daily run time from TODO_RUN_TIME (24h "HH:MM") in FocusMemory/.env.
 * Unset or invalid values fall back to DEFAULT_RUN_TIME — the runner
 * must never crash-loop on a bad config value (PM2 would restart it).
 * @returns {{hour: number, minute: number, source: string}} parsed time
 *   and where it came from ("TODO_RUN_TIME" | "default")
 */
function parseRunTime() {
  const raw = (process.env.TODO_RUN_TIME || "").trim();
  const m = raw.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (m) return { hour: Number(m[1]), minute: Number(m[2]), source: "TODO_RUN_TIME" };
  if (raw) {
    log(`TODO_RUN_TIME "${raw}" is invalid (expected 24h HH:MM) — using default ${DEFAULT_RUN_TIME}.`);
  }
  const [h, min] = DEFAULT_RUN_TIME.split(":").map(Number);
  return { hour: h, minute: min, source: "default" };
}

const RUN_TIME = parseRunTime();
const SCHEDULE_HOUR = RUN_TIME.hour;
const SCHEDULE_MINUTE = RUN_TIME.minute;

function nextRunDate() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(SCHEDULE_HOUR, SCHEDULE_MINUTE, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function scheduleNext() {
  const next = nextRunDate();
  const delay = next.getTime() - Date.now();
  log(`Next run scheduled: ${next.toISOString()} (in ${Math.round(delay / 60000)} min)`);

  setTimeout(async () => {
    try {
      await runTodo();
    } catch (err) {
      log(`Error: ${err.message}`);
    }
    scheduleNext();
  }, delay);
}

// ─── Startup ──────────────────────────────────────────────────────

log(`todoRunner started (PID ${process.pid}) — DB queue mode (udanax.todo_tasks)`);
log(`Workspace: ${WORKSPACE}`);
log(`Log directory: ${LOG_DIR}`);
log(
  `Run time: ${String(SCHEDULE_HOUR).padStart(2, "0")}:${String(SCHEDULE_MINUTE).padStart(2, "0")}` +
    ` (${RUN_TIME.source}) | night limit: ${NIGHT_LIMIT} | task timeout: ${TASK_TIMEOUT_MIN} min | auto-ingest: ${AUTO_INGEST ? "on" : "off"}`
);

// Dry run: query pending tasks, print, exit (no qwen, no state write)
if (process.argv.includes("--dry-run")) {
  taskdb
    .fetchPendingTasks({ limit: NIGHT_LIMIT })
    .then((tasks) => {
      if (tasks.length === 0) {
        log("Dry run: no pending tasks (scheduled_date <= today).");
        process.exit(0);
      }
      log(`Dry run: ${tasks.length} pending task(s):`);
      for (const t of tasks) {
        log(`  #${t.id} [${t.source}] scheduled=${t.scheduled_date} — ${t.title}`);
      }
      process.exit(0);
    })
    .catch((err) => {
      log(`Dry run failed: ${err.message}`);
      process.exit(1);
    });
}

// Support manual trigger: `node todoRunner.js --now`
if (process.argv.includes("--now")) {
  log("Manual trigger (--now)");
  runTodo("manual")
    .catch((err) => log(`Error: ${err.message}`))
    .finally(() => scheduleNext());
} else {
  scheduleNext();
}
