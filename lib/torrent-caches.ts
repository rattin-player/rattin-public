// lib/torrent-caches.ts
// Central registry for all per-torrent in-memory caches.
// Every Map/Set keyed by infoHash or "infoHash:fileIndex" MUST be
// registered here so that cleanupHash() and pruneOrphans() cover it.

import type { CacheKeyStyle, CacheRegistration } from "./types.js";

/**
 * Build a normalized cache key "infohash:fileindex".
 */
export function jobKey(infoHash: string, fileIndex: number | string): string {
  return `${infoHash.toLowerCase()}:${fileIndex}`;
}

// ── Registry internals ──

const _registered: CacheRegistration[] = [];

/**
 * Register a Map or Set for automatic cleanup.
 */
export function registerCache(name: string, map: Map<string, unknown> | Set<string>, keyStyle: CacheKeyStyle = "hash:index"): void {
  _registered.push({ name, map, keyStyle });
}

/**
 * Remove all entries for a given infoHash across every registered cache.
 * For "path"-keyed caches (probeCache), supply file paths to delete.
 */
export function cleanupHash(infoHash: string, filePaths: string[] = []): void {
  const prefix = infoHash.toLowerCase() + ":";
  for (const { map, keyStyle } of _registered) {
    if (keyStyle === "hash") {
      map.delete(infoHash);
    } else if (keyStyle === "hash:index") {
      for (const key of [...(map instanceof Set ? map : map.keys())]) {
        if (key.startsWith(prefix)) {
          map.delete(key);
        }
      }
    } else if (keyStyle === "path") {
      for (const p of filePaths) {
        map.delete(p);
      }
    }
  }
}

/**
 * Remove cache entries whose infoHash is not in the active set.
 * For path-keyed caches, remove entries whose file no longer exists on disk.
 */
export function pruneOrphans(activeHashes: Set<string>, statSyncFn: (path: string) => unknown): number {
  let pruned = 0;
  for (const { map, keyStyle } of _registered) {
    const keys: string[] = map instanceof Set ? [...map] : [...map.keys()];
    for (const key of keys) {
      let shouldDelete = false;
      if (keyStyle === "hash:index") {
        shouldDelete = !activeHashes.has(key.split(":")[0]);
      } else if (keyStyle === "hash") {
        shouldDelete = !activeHashes.has(key);
      } else if (keyStyle === "path") {
        try { statSyncFn(key); } catch { shouldDelete = true; }
      }
      if (shouldDelete) {
        map.delete(key);
        pruned++;
      }
    }
  }
  return pruned;
}

/**
 * Return sizes of all registered caches for logging.
 */
export function cacheStats(): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const { name, map } of _registered) {
    stats[name] = map.size;
  }
  return stats;
}
