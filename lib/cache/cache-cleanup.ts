import { readdir, stat, rm } from "fs/promises";
import path from "path";
import type { LogFn } from "../types.js";

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Delete all entries in `dir` older than 24h.
 * Best-effort: errors on individual entries are logged and skipped.
 */
export async function sweepOldFiles(dir: string, log: LogFn): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // directory doesn't exist yet — nothing to sweep
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const name of entries) {
    const fullPath = path.join(dir, name);
    try {
      const s = await stat(fullPath);
      if (s.mtimeMs < cutoff) {
        await rm(fullPath, { recursive: true, force: true });
        log("info", "Sweep: removed stale cache entry", { name });
        removed++;
      }
    } catch (err) {
      log("warn", "Sweep: failed to remove entry", { name, error: (err as Error).message });
    }
  }
  return removed;
}

/**
 * Calculate total size of all files in `dir` (recursive).
 */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const fullPath = path.join(dir, name);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        total += await dirSize(fullPath);
      } else {
        total += s.blocks !== undefined ? s.blocks * 512 : s.size;
      }
    } catch {
      // skip unreadable entries
    }
  }
  return total;
}

/**
 * Delete everything inside `dir` without removing `dir` itself.
 */
export async function clearDir(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries.map((name) => rm(path.join(dir, name), { recursive: true, force: true })),
  );
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / 1024 ** i;
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}
