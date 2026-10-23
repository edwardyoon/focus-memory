/**
 * taskdb.js — udanax.todo_tasks access module (02:00 autonomous TODO runner queue).
 *
 * DB access rule (workspace convention):
 *   - writes (insert / status change) → 120 master (TASK_DB_HOST)
 *   - reads  (queue fetch / listing)  → 121 slave  (TASK_DB_SLAVE_HOST)
 *   - exception: getTask() reads the MASTER — the runner's post-run
 *     verification must not see replication lag right after the agent's
 *     finish_task write.
 *
 * env (FocusMemory/.env): TASK_DB_HOST, TASK_DB_SLAVE_HOST, TASK_DB_USER,
 * TASK_DB_PASS, TASK_DB_NAME. Values are read LAZILY (at first pool use) so
 * this module can be imported before dotenv has loaded .env (ESM import
 * hoisting in index.js).
 *
 * Shared by:
 *   - index.js (ESM)      — put_task / finish_task MCP tools
 *   - taskReceiver.cjs    — `await import("./lib/taskdb.js")` (CJS)
 *   - todoRunner.js (ESM) — queue fetch / optimistic lock / result fallback
 */

import mysql from "mysql2/promise";

const POOL_OPTS = {
  connectionLimit: 2,
  waitForConnections: true,
  queueLimit: 0,
  connectTimeout: 10000,
  dateStrings: true, // DATE/DATETIME/TIMESTAMP come back as strings
};

let masterPool = null;
let slavePool = null;

/**
 * Master pool (writes). Created lazily on first use.
 * @returns {import("mysql2/promise").Pool}
 */
function getMasterPool() {
  if (!masterPool) {
    masterPool = mysql.createPool({
      host: process.env.TASK_DB_HOST || "192.168.219.120",
      user: process.env.TASK_DB_USER,
      password: process.env.TASK_DB_PASS,
      database: process.env.TASK_DB_NAME || "udanax",
      ...POOL_OPTS,
    });
  }
  return masterPool;
}

/**
 * Slave pool (reads). Created lazily on first use.
 * Falls back to the master host when TASK_DB_SLAVE_HOST is unset.
 * @returns {import("mysql2/promise").Pool}
 */
function getSlavePool() {
  if (!slavePool) {
    slavePool = mysql.createPool({
      host: process.env.TASK_DB_SLAVE_HOST || process.env.TASK_DB_HOST || "192.168.219.120",
      user: process.env.TASK_DB_USER,
      password: process.env.TASK_DB_PASS,
      database: process.env.TASK_DB_NAME || "udanax",
      ...POOL_OPTS,
    });
  }
  return slavePool;
}

/**
 * Format a Date as local-timezone YYYY-MM-DD.
 * @param {Date} d
 * @returns {string}
 */
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Insert a new task into the queue (120 master).
 * @param {object} p
 * @param {string} p.title - item title (truncated to 255 chars)
 * @param {string} p.content - task body (LLM-formatted result or raw text)
 * @param {string} [p.rawText] - registration raw text
 * @param {string} [p.source] - admin | mcp | manual
 * @param {string} [p.scheduledDate] - YYYY-MM-DD (default: tomorrow, local/KST)
 * @returns {Promise<{id: number}>} new row id
 */
export async function insertTask({ title, content, rawText = null, source = "admin", scheduledDate = null }) {
  const conn = await getMasterPool().getConnection();
  try {
    let date = scheduledDate;
    if (!date) {
      const t = new Date();
      t.setDate(t.getDate() + 1);
      date = fmtDate(t);
    }
    const [result] = await conn.execute(
      "INSERT INTO todo_tasks (title, content, raw_text, source, scheduled_date) VALUES (?, ?, ?, ?, ?)",
      [String(title).slice(0, 255), content, rawText, source, date]
    );
    return { id: result.insertId };
  } finally {
    conn.release();
  }
}

/**
 * Fetch pending tasks due for execution (121 slave).
 * Due = status 'pending' AND scheduled_date <= CURDATE() (catch-up included).
 * @param {{limit?: number}} [opts] max rows (default 10)
 * @returns {Promise<Array<{id: number, title: string, content: string, raw_text: string|null, source: string, scheduled_date: string, retry_count: number}>>}
 */
export async function fetchPendingTasks({ limit = 10 } = {}) {
  const conn = await getSlavePool().getConnection();
  try {
    const [rows] = await conn.execute(
      "SELECT id, title, content, raw_text, source, scheduled_date, retry_count FROM todo_tasks WHERE status = 'pending' AND scheduled_date <= CURDATE() ORDER BY id LIMIT ?",
      [Math.max(1, Math.min(1000, limit))]
    );
    return rows;
  } finally {
    conn.release();
  }
}

/**
 * Optimistic lock: pending → running (120 master).
 * @param {number} id
 * @returns {Promise<boolean>} true when THIS caller acquired the task
 */
export async function markRunning(id) {
  const conn = await getMasterPool().getConnection();
  try {
    const [result] = await conn.execute(
      "UPDATE todo_tasks SET status = 'running', started_at = NOW() WHERE id = ? AND status = 'pending'",
      [id]
    );
    return result.affectedRows === 1;
  } finally {
    conn.release();
  }
}

/**
 * Fetch a single task — MASTER (fresh read, no replication lag).
 * @param {number} id
 * @returns {Promise<object|null>} full row, or null when absent
 */
export async function getTask(id) {
  const conn = await getMasterPool().getConnection();
  try {
    const [rows] = await conn.execute("SELECT * FROM todo_tasks WHERE id = ?", [id]);
    return rows[0] || null;
  } finally {
    conn.release();
  }
}

/**
 * Update the task result (120 master) — runner's failed-fallback path.
 * @param {number} id
 * @param {object} p
 * @param {string} p.status - done | failed
 * @param {string} [p.resultSummary]
 * @param {string} [p.error]
 * @param {number} [p.retryCount] bump retry_count when provided
 * @returns {Promise<void>}
 */
export async function updateResult(id, { status, resultSummary = null, error = null, retryCount = null }) {
  const conn = await getMasterPool().getConnection();
  try {
    if (retryCount != null) {
      await conn.execute(
        "UPDATE todo_tasks SET status = ?, result_summary = ?, error = ?, retry_count = ?, finished_at = NOW() WHERE id = ?",
        [status, resultSummary, error, retryCount, id]
      );
    } else {
      await conn.execute(
        "UPDATE todo_tasks SET status = ?, result_summary = ?, error = ?, finished_at = NOW() WHERE id = ?",
        [status, resultSummary, error, id]
      );
    }
  } finally {
    conn.release();
  }
}

/**
 * finish_task guard: running → done|failed (120 master).
 * Accepts ONLY rows currently in 'running' — wrong id / duplicate report
 * returns {ok:false} so the caller gets an explicit error.
 * @param {number} id
 * @param {'done'|'failed'} status
 * @param {object} [p]
 * @param {string} [p.resultSummary]
 * @param {string} [p.error]
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function finishTask(id, status, { resultSummary = null, error = null } = {}) {
  const conn = await getMasterPool().getConnection();
  try {
    const [result] = await conn.execute(
      "UPDATE todo_tasks SET status = ?, result_summary = ?, error = ?, finished_at = NOW() WHERE id = ? AND status = 'running'",
      [status, resultSummary, error, id]
    );
    if (result.affectedRows === 1) {
      return { ok: true, message: `task ${id} marked ${status}` };
    }
    const [rows] = await conn.execute("SELECT status FROM todo_tasks WHERE id = ?", [id]);
    if (rows.length === 0) {
      return { ok: false, message: `no todo_tasks row with id ${id}` };
    }
    return { ok: false, message: `task ${id} is '${rows[0].status}', not 'running' — already processed or not started` };
  } finally {
    conn.release();
  }
}

/**
 * List tasks by scheduled_date range (121 slave) — receiver /toc.
 * @param {object} p
 * @param {string} p.from - YYYY-MM-DD (inclusive)
 * @param {string} p.to - YYYY-MM-DD (inclusive)
 * @param {number} [p.limit] max rows (default 200)
 * @returns {Promise<Array<object>>} rows ordered by scheduled_date DESC, id DESC
 */
export async function listTasks({ from, to, limit = 200 }) {
  const conn = await getSlavePool().getConnection();
  try {
    const [rows] = await conn.execute(
      "SELECT id, title, status, source, result_summary, error, scheduled_date, created_at, finished_at FROM todo_tasks WHERE scheduled_date BETWEEN ? AND ? ORDER BY scheduled_date DESC, id DESC LIMIT ?",
      [from, to, limit]
    );
    return rows;
  } finally {
    conn.release();
  }
}
