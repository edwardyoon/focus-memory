#!/usr/bin/env node
/**
 * todoRunner.js — Scheduled TODO execution runner (PM2-managed).
 *
 * Runs daily in the early morning (default 06:00, configurable via
 * TODO_RUN_TIME in FocusMemory/.env) for backlog management. The TODO file
 * (todos/{date}.md) holds the next day's work plan — organized in the
 * previous evening — plus any carry-over items. The early-morning run
 * executes it while the user is away, so results are ready for review when
 * the work day starts.
 * 1. Target selection: today's TODO file; if it has no pending items (or is
 *    missing), scans the last CATCHUP_LOOKBACK_DAYS for the most recent file
 *    with leftovers, so a failed run is never orphaned by a date rollover.
 * 2. Spawns `qwen` with default instructions + execution prompt, logs output.
 * 3. Final verification: re-reads the file, counts remaining pending item
 *    headers, logs them, and records the outcome (exit code, duration,
 *    pending before/after, error line) in todo_runner_state.json.
 * 4. Triggers FocusMemory auto-ingest on completion.
 * 5. Optional post-run verification: when POSTRUN_TEST_SCRIPT is set in
 *    FocusMemory/.env, the script runs ONCE at the very end of a fully
 *    completed run (all items [x] + clean qwen exit) — never per item.
 *    On a non-zero exit, one qwen fix round is delegated, then the script
 *    is re-run as the independent arbiter. Unset = disabled (no-op).
 */

import { spawn } from "child_process";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load FocusMemory/.env (existing process env wins over file values).
dotenv.config({ path: path.join(__dirname, ".env") });
const WORKSPACE = path.resolve(__dirname, "..");
const TODOS_DIR = path.join(WORKSPACE, "todos");
const LOG_DIR = "/tmp/focus-memory";
const QWEN_BIN = "/opt/homebrew/bin/qwen";
const FOCUSMEMORY_DIR = __dirname;
const CATCHUP_LOOKBACK_DAYS = 3; // scan this many past days for leftover items
const STATE_FILE = path.join(FOCUSMEMORY_DIR, "todo_runner_state.json");

// ─── Default instructions (injected into every execution prompt) ───

const DEFAULT_INSTRUCTIONS = `CRITICAL INSTRUCTIONS:
- Do NOT commit, push, or deploy. All changes will be reviewed by the user later the same day.
- Process items sequentially, one at a time. Do NOT use parallel sub-agents.
- Progress tracking: Handle ONE item at a time. On start, update its \`##\` header checkbox \`[ ]\` → \`[~]\` (in progress). On completion, update to \`[x]\` and add a 1-2 line result summary below the item. If interrupted or partially done, mark \`[!]\` with "last completed step / remaining steps" so the next run can resume exactly where it left off. For large items, update internal checkboxes (Steps) at each stage.
- Workspace: /opt/homebrew/var/www
- This file is a TODO record. Execute items in order from top to bottom.
- Verification: DDL/data changes ONLY to local DB (127.0.0.1). All functional verification in local environment (127.0.0.1:3000 + headless). Production DB/server is READ-ONLY (zero access).`;

// ─── Helpers ──────────────────────────────────────────────────────

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
 * Top-level item headers that are not completed: "## [ ]", "## [~]", "## [!]".
 * Inner step checkboxes are ignored — the item header is the contract.
 * @param {string} content
 * @returns {string[]} matching header lines
 */
function listPendingHeaders(content) {
  return content.match(/^## \[(?: |~|!)\].*$/gm) || [];
}

/**
 * Pick the TODO file to process: today's file if it has pending items,
 * otherwise the most recent past file within CATCHUP_LOOKBACK_DAYS with
 * leftovers (a failed run must not be orphaned by a date rollover).
 * @returns {{file: string, date: string, isCatchup: boolean} | null}
 */
function findTargetFile() {
  for (let i = 0; i <= CATCHUP_LOOKBACK_DAYS; i++) {
    const date = dateStr(i);
    const file = path.join(TODOS_DIR, `${date}.md`);
    if (!fs.existsSync(file)) continue;
    const pending = listPendingHeaders(fs.readFileSync(file, "utf-8"));
    if (pending.length > 0) {
      return { file, date, isCatchup: i > 0 };
    }
  }
  return null;
}

/**
 * Pull the most relevant error line from a run log.
 * @param {string} logPath
 * @returns {string} error line, or "" if none found
 */
function extractError(logPath) {
  try {
    const log = fs.readFileSync(logPath, "utf-8");
    const apiErrors = log.match(/\[?API Error:[^\n]*/g);
    if (apiErrors && apiErrors.length > 0) {
      return apiErrors[apiErrors.length - 1].trim();
    }
    const spawnErr = log.match(/=== spawn error: [^\n]*/);
    if (spawnErr) return spawnErr[0].trim();
  } catch {
    // log file missing — no extractable error
  }
  return "";
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
  state.consecutiveFailures =
    record.exitCode !== 0 ? (state.consecutiveFailures || 0) + 1 : 0;
  state.lastRun = record;
  state.history = [...(state.history || []), record].slice(-30);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Spawn a child process and wait for it to finish.
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} logPath
 * @param {string} [cwd]
 * @param {object} [env]
 * @returns {Promise<number>} exit code
 */
function runProcess(cmd, args, logPath, cwd, env) {
  return new Promise((resolve) => {
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.write(`\n=== ${cmd} ${args.join(" ")} ===\n`);

    const child = spawn(cmd, args, {
      cwd: cwd || WORKSPACE,
      env: env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      logStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      logStream.write(chunk);
    });
    child.on("close", (code) => {
      logStream.end(`\n=== exit code: ${code} ===\n`);
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      logStream.write(`\n=== spawn error: ${err.message} ===\n`);
      logStream.end();
      resolve(1);
    });
  });
}

/**
 * Run the optional post-run verification script (POSTRUN_TEST_SCRIPT in
 * FocusMemory/.env, absolute or workspace-relative). Invoked exactly once
 * per runTodo cycle — never per item — and only after ALL items completed
 * with a clean qwen exit. On failure, one fix round is delegated to qwen
 * (with the failure log), then the script is re-run as the independent
 * arbiter. No retry loop beyond that single fix round.
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
  const firstCode = await runProcess("bash", [scriptPath], logPath, WORKSPACE);

  if (firstCode === 0) {
    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    log(`Post-run verification: PASSED (${durationSec}s)`);
    return { configured: true, ran: true, passed: true, fixed: false, exitCode: 0, durationSec };
  }

  log(`Post-run verification: FAILED (exit ${firstCode}) — delegating one fix round to qwen...`);
  const fixPrompt = `${DEFAULT_INSTRUCTIONS}

The post-run verification script failed after the TODO run completed.
Script: ${scriptPath}
Its full output is appended to: ${logPath} (see the last "bash ${scriptPath}" section).

Diagnose the failing tests and fix the workspace code (local environment only, 127.0.0.1).
Then re-run the script yourself and confirm it exits 0.
Do NOT modify the verification script itself unless a test is objectively wrong — if you do, explain why.`;
  const fixCode = await runProcess(QWEN_BIN, ["-p", fixPrompt], logPath, WORKSPACE, env);
  log(`Post-run verification: fix round exited with code ${fixCode} — re-running script to verify...`);
  const reCode = await runProcess("bash", [scriptPath], logPath, WORKSPACE);
  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  if (reCode === 0) {
    log(`Post-run verification: PASSED after fix round (${durationSec}s)`);
    return { configured: true, ran: true, passed: true, fixed: true, exitCode: 0, durationSec };
  }
  log(`Post-run verification: still FAILED after fix round (exit ${reCode}) — leaving for user review.`);
  return { configured: true, ran: true, passed: false, fixed: true, exitCode: reCode, durationSec };
}

// ─── Main execution ───────────────────────────────────────────────

/**
 * Execute the TODO run: pick target file, spawn qwen, auto-ingest,
 * then verify completion and record the outcome.
 * @param {string} [trigger="schedule"] "schedule" | "manual"
 * @returns {Promise<void>}
 */
async function runTodo(trigger = "schedule") {
  const target = findTargetFile();
  const logPath = target ? path.join(LOG_DIR, `todo-${target.date}.log`) : null;

  ensureLogDir();

  if (!target) {
    log(`No pending items in today's file or the last ${CATCHUP_LOOKBACK_DAYS} days. Nothing to do.`);
    return;
  }

  const { file: todoFile, date, isCatchup } = target;
  const startedAt = Date.now();

  log(
    `--- Todo runner triggered for ${date} ` +
      `(${isCatchup ? "CATCH-UP from earlier file" : "daily"}, trigger: ${trigger}) ---`
  );

  const pendingBefore = listPendingHeaders(fs.readFileSync(todoFile, "utf-8"));

  const prompt = `${DEFAULT_INSTRUCTIONS}

Read the TODO file: ${todoFile}${
    isCatchup
      ? ` (carry-over from ${date} — resume exactly where it left off)`
      : " (today's TODO file)"
  }
Execute the pending items (marked [ ], [~] or [!]) from top to bottom, one at a time.
After each item, update its checkbox and record a 1-2 line summary in the file.`;

  // Build env for qwen: ensure PATH and project dir are explicit
  const qwenEnv = {
    ...process.env,
    PATH: `/opt/homebrew/bin:${path.join(process.env.HOME, ".local", "bin")}:${process.env.PATH || "/usr/bin:/bin"}`.split(":").filter(Boolean).join(":"),
    QWEN_CODE_PROJECT_DIR: path.join(process.env.HOME, ".qwen", "projects", "-opt-homebrew-var-www"),
  };

  log(`Spawning qwen execution...`);
  const code = await runProcess(
    QWEN_BIN,
    ["-p", prompt],
    logPath,
    WORKSPACE,
    qwenEnv,
  );
  log(`qwen exited with code ${code}`);

  // Trigger auto-ingest to update FocusMemory index
  log("Triggering auto-ingest...");
  const ingestCode = await runProcess(
    "node",
    ["autoIngest.js"],
    logPath,
    FOCUSMEMORY_DIR,
  );
  log(`auto-ingest exited with code ${ingestCode}`);

  // ── Final verification: did the run actually finish the work? ──
  let pendingAfter = null;
  try {
    pendingAfter = listPendingHeaders(fs.readFileSync(todoFile, "utf-8"));
  } catch {
    log("Final check: TODO file missing after run — cannot verify.");
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  const error = code !== 0 ? extractError(logPath) : "";

  if (pendingAfter !== null) {
    if (pendingAfter.length === 0) {
      log(
        `Final check: ALL items completed ` +
          `(was ${pendingBefore.length} pending, ${durationSec}s)`
      );
    } else {
      log(
        `Final check: ${pendingBefore.length} → ${pendingAfter.length} pending ` +
          `(${durationSec}s). Remaining:`
      );
      for (const header of pendingAfter) {
        log(`  ${header.trim()}`);
      }
    }
  }
  if (code !== 0) {
    log(
      `ERROR: qwen failed (exit ${code})${error ? ` — ${error}` : ""}. ` +
        `Leftover items will be picked up by the next run.`
    );
  }

  // ── Post-run verification (optional): ONCE, only after a fully completed run ──
  let postRun = null;
  if (code === 0 && pendingAfter !== null && pendingAfter.length === 0) {
    postRun = await runPostRunTest(logPath, qwenEnv);
  }

  saveState({
    at: new Date().toISOString(),
    trigger,
    file: path.relative(WORKSPACE, todoFile),
    date,
    catchup: isCatchup,
    exitCode: code,
    durationSec,
    pendingBefore: pendingBefore.length,
    pendingAfter: pendingAfter === null ? null : pendingAfter.length,
    remaining:
      pendingAfter === null ? ["<file missing>"] : pendingAfter.map((h) => h.trim()),
    error,
    postRun,
  });
}

// ─── Scheduler ────────────────────────────────────────────────────

const DEFAULT_RUN_TIME = "06:00"; // 24h "HH:MM" — TODO_RUN_TIME 미설정/오류 시 폴백

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
  return { hour: 6, minute: 0, source: "default" };
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

log(`todoRunner started (PID ${process.pid})`);
log(`TODOS_DIR: ${TODOS_DIR}`);
log(`Log directory: ${LOG_DIR}`);
log(
  `Run time: ${String(SCHEDULE_HOUR).padStart(2, "0")}:${String(SCHEDULE_MINUTE).padStart(2, "0")}` +
    ` (${RUN_TIME.source})`
);

// Dry run: resolve target + pending items, print, exit (no qwen, no state write)
if (process.argv.includes("--dry-run")) {
  const target = findTargetFile();
  if (!target) {
    log("Dry run: no pending items in today's file or the lookback window.");
    process.exit(0);
  }
  const pending = listPendingHeaders(fs.readFileSync(target.file, "utf-8"));
  log(`Dry run: target=${target.date} (catchup=${target.isCatchup}), pending=${pending.length}`);
  for (const header of pending) {
    log(`  ${header.trim()}`);
  }
  process.exit(0);
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
