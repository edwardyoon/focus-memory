// FocusMemory garbage collection — time-based retention for unbounded
// accumulators. Decisions (work_memory type=decision/bug_resolved),
// decision_chains, graph_* and code_chunks are NEVER age-pruned — causal-chain
// integrity and code-index freshness are managed elsewhere (recency decay,
// file-existence sync).
//
//   The todo queue is DB-based (udanax.todo_tasks, lib/taskdb.js) — the old
//   file-archive phase (todos/YYYY-MM-DD.md → todos_archive/) was removed
//   with the file-based todos; DB rows have no retention.
//
//   Phase A — work_memory points with type=state_checkpoint and
//             timestamp < cutoff are deleted by explicit ID list (narrow
//             filter + ID delete; no broad filter delete against work_memory).
//   Phase B — the ENTIRE ~/.qwen/tmp tree: files with mtime older than
//             GC_SESSION_RETENTION_DAYS are deleted, then directories that
//             become empty are removed (bottom-up). qwen-code never cleans
//             this tree itself (per-session attachments, tool-results,
//             background-shells, logs, scheduled_tasks), so without this it
//             grows unbounded. Active sessions keep rewriting their files, so
//             mtime is the liveness signal — anything written within the
//             window is never deleted.
//
// Usage:
//   node garbageCollect.js            # live run (requires GC_ENABLED=on)
//   node garbageCollect.js --dry-run  # report only, nothing is changed
// Scheduled daily via config/com.focusmemory.gc.plist (launchd).

import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "path";
import fs from "fs/promises";
import { QdrantClient } from "@qdrant/js-client-rest";

dotenv.config({
  override: true,
  quiet: true,
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env"),
});

const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const GC_LOG_FILE = "/tmp/focus-memory/gc.log";

// Phase B — sweep root (see header): the whole tree under this dir is
// age-pruned by file mtime.
const QWEN_TMP = path.join(os.homedir(), ".qwen", "tmp");

const LOCK_FILE = "/tmp/focusmemory-gc.lock";
const LOCK_STALE_MS = 30 * 60 * 1000; // 30 min

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Parse a positive integer from an env value, falling back to a default.
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function daysToNumber(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Log one line to stdout and append it to logs/gc.log. Best-effort:
 * a log failure never fails the GC run.
 * @param {string} line
 * @returns {Promise<void>}
 */
async function gcLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    await fs.mkdir(path.dirname(GC_LOG_FILE), { recursive: true });
    await fs.appendFile(GC_LOG_FILE, stamped + "\n");
  } catch {}
}

/**
 * Acquire the GC lock (same pattern as autoIngest.js): a stale lock whose
 * PID is dead is taken over; a live lock makes this run exit quietly.
 * @returns {Promise<void>}
 */
async function acquireLock() {
  try {
    const existing = await fs.readFile(LOCK_FILE, "utf-8").catch(() => null);
    if (existing) {
      const { pid, ts } = JSON.parse(existing);
      if (Date.now() - ts < LOCK_STALE_MS) {
        try {
          process.kill(pid, 0);
          console.error(`[lock] Another GC is running (PID ${pid}). Exiting.`);
          process.exit(0);
        } catch {
          // PID dead — stale lock, proceed
        }
      }
    }
    await fs.writeFile(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } catch {
    // Lock file write failed — proceed without lock (fail-open)
  }
}

/**
 * Release the GC lock. Best-effort.
 * @returns {Promise<void>}
 */
async function releaseLock() {
  try {
    await fs.unlink(LOCK_FILE);
  } catch {}
}

/**
 * Phase A — delete work_memory state_checkpoint points older than the
 * retention window. Only point IDs collected under the narrow
 * (type=state_checkpoint AND timestamp < cutoff) filter are deleted.
 * @param {QdrantClient} qdrant
 * @param {number} retentionDays
 * @returns {Promise<number>} number of points deleted (0 in dry-run means
 *   none matched; the matched count is reported either way)
 */
async function gcCheckpoints(qdrant, retentionDays) {
  const cutoffISO = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const ids = [];
  let offset = null;
  do {
    const req = {
      filter: {
        must: [
          { key: "type", match: { value: "state_checkpoint" } },
          { key: "timestamp", range: { lt: cutoffISO } },
        ],
      },
      limit: 1000,
      with_payload: false,
    };
    if (offset) req.offset = offset;
    const res = await qdrant.scroll("work_memory", req);
    for (const p of res.points) ids.push(p.id);
    offset = res.next_page_offset ?? null;
  } while (offset);

  if (ids.length === 0) return 0;
  if (!DRY_RUN) {
    for (let i = 0; i < ids.length; i += 500) {
      await qdrant.delete("work_memory", { wait: true, points: ids.slice(i, i + 500) });
    }
  }
  return ids.length;
}

/**
 * Phase B — sweep the entire ~/.qwen/tmp tree: delete files whose mtime is
 * older than the retention window, then remove directories that become empty
 * (bottom-up). A file written within the window (an active session) is never
 * deleted; mtime is the liveness signal. Symlinks and special entries are
 * left untouched.
 * @param {number} retentionDays
 * @returns {Promise<{removed: string[], dirsRemoved: number}>} full paths of
 *   the files removed (in dry-run: the files that would be removed) and the
 *   number of directories removed (in dry-run: that would be removed)
 */
async function gcQwenTmp(retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  const removed = [];
  const gone = new Set();
  let dirsRemoved = 0;

  /**
   * Recursively sweep one directory, children first (post-order).
   * @param {string} dir
   * @returns {Promise<void>}
   */
  async function sweep(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir absent — nothing to sweep
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await sweep(full);
        // The dir survives iff at least one child is still live.
        const live = entries.some((c) => !gone.has(path.join(dir, c.name)));
        if (!live) {
          if (!DRY_RUN) {
            try {
              await fs.rmdir(full);
            } catch (err) {
              console.error(`  ✗ qwen-tmp dir: ${full} — ${err.message}`);
              continue;
            }
          }
          gone.add(full);
          dirsRemoved++;
        }
      } else if (e.isFile()) {
        try {
          const st = await fs.stat(full);
          if (st.mtimeMs >= cutoff) continue; // active — keep
          if (!DRY_RUN) await fs.unlink(full);
          gone.add(full);
          removed.push(full);
        } catch (err) {
          console.error(`  ✗ qwen-tmp file: ${full} — ${err.message}`);
        }
      }
      // symlinks and other special entries: left untouched
    }
  }

  await sweep(QWEN_TMP);
  return { removed, dirsRemoved };
}

/**
 * GC entry point: runs Phase A (checkpoint retention) and Phase B
 * (~/.qwen/tmp tree retention) when GC_ENABLED=on, logging a one-line
 * summary to gc.log.
 * @returns {Promise<void>}
 */
async function main() {
  const enabled = (process.env.GC_ENABLED || "off").toLowerCase() === "on";
  console.log("=== FocusMemory GC ===");
  console.log(`[mode] ${DRY_RUN ? "DRY-RUN" : "live"}`);
  if (!enabled) {
    console.log("[skip] GC_ENABLED is not 'on' — nothing to do");
    return;
  }

  await acquireLock();
  const checkpointDays = daysToNumber(process.env.GC_CHECKPOINT_RETENTION_DAYS, 30);
  const sessionDays = daysToNumber(process.env.GC_SESSION_RETENTION_DAYS, 7);
  console.log(
    `[config] checkpoint retention ${checkpointDays}d, ` +
      `qwen-tmp retention ${sessionDays}d`
  );

  try {
    // ── Phase A: state_checkpoint retention ──────────────────────
    console.log(`--- Phase A: state_checkpoint retention (${checkpointDays}d) ---`);
    const qdrant = new QdrantClient({ url: QDRANT_URL });
    let removed = 0;
    try {
      removed = await gcCheckpoints(qdrant, checkpointDays);
    } catch (err) {
      console.error(`  ✗ checkpoint GC failed (Qdrant unreachable?): ${err.message}`);
    }
    console.log(`  ${DRY_RUN ? "would delete" : "deleted"} ${removed} state_checkpoint point(s)`);

    // ── Phase B: ~/.qwen/tmp tree retention ──────────────────────
    console.log(`--- Phase B: ~/.qwen/tmp tree retention (${sessionDays}d) ---`);
    const { removed: tmpRemoved, dirsRemoved } = await gcQwenTmp(sessionDays);
    console.log(
      `  ${DRY_RUN ? "would delete" : "deleted"} ${tmpRemoved.length} file(s) + ${dirsRemoved} emptied dir(s) under ~/.qwen/tmp`
    );
    for (const p of tmpRemoved) {
      console.log(`  [qwen-tmp] ${p}`);
    }

    await gcLog(
      `gc ${DRY_RUN ? "dry-run" : "run"} checkpoints_removed=${removed} ` +
        `tmp_removed=${tmpRemoved.length} tmp_dirs_removed=${dirsRemoved}`
    );
    console.log("=== Done ===");
  } finally {
    await releaseLock();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  releaseLock();
  process.exit(1);
});
