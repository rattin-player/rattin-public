import { readdir, stat, rm } from "fs/promises";
import { statfsSync } from "fs";
import path from "path";
import type { LogFn } from "../types.js";

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_FREE_BYTES = 2 * 1024 ** 3; // 2 GB — trigger eviction below this

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

/**
 * Check free disk space on the filesystem containing `dir`.
 * If below threshold, evict oldest entries until enough space is recovered.
 * Skips directories whose names match active infoHashes.
 */
export async function evictIfLowSpace(
  dir: string,
  activeHashes: Set<string>,
  log: LogFn,
): Promise<number> {
  let freeBytes: number;
  try {
    const fs = statfsSync(dir);
    freeBytes = fs.bavail * fs.bsize;
  } catch {
    return 0; // can't stat filesystem — skip
  }
  if (freeBytes >= MIN_FREE_BYTES) return 0;

  const freeMB = Math.round(freeBytes / (1024 ** 2));
  log("warn", `Low disk space (${freeMB} MB free), evicting old cache files...`);

  // List all entries with their modification time
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  const items: { name: string; fullPath: string; mtimeMs: number; size: number }[] = [];
  for (const name of entries) {
    if (activeHashes.has(name)) continue; // protect active torrents
    const fullPath = path.join(dir, name);
    try {
      const s = await stat(fullPath);
      const size = s.isDirectory() ? await dirSize(fullPath) : (s.blocks !== undefined ? s.blocks * 512 : s.size);
      items.push({ name, fullPath, mtimeMs: s.mtimeMs, size });
    } catch {
      // skip unreadable
    }
  }

  // Sort oldest first
  items.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let evicted = 0;
  let freedBytes = 0;
  for (const item of items) {
    if (freeBytes + freedBytes >= MIN_FREE_BYTES) break;
    try {
      await rm(item.fullPath, { recursive: true, force: true });
      freedBytes += item.size;
      evicted++;
      log("info", "Evicted cache entry", { name: item.name, size: formatBytes(item.size) });
    } catch {
      // skip failures
    }
  }

  if (evicted > 0) {
    log("warn", `Disk space eviction complete`, { evicted, freed: formatBytes(freedBytes) });
  }
  return evicted;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / 1024 ** i;
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}
