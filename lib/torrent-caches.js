// lib/torrent-caches.js
// Central registry for all per-torrent in-memory caches.
// Every Map/Set keyed by infoHash or "infoHash:fileIndex" MUST be
// registered here so that cleanupHash() and pruneOrphans() cover it.

/**
 * @param {string} infoHash
 * @param {number|string} fileIndex
 * @returns {string} Normalized cache key "infohash:fileindex"
 */
export function jobKey(infoHash, fileIndex) {
  return `${infoHash.toLowerCase()}:${fileIndex}`;
}

// ── Registry internals ──

// { name, map, keyStyle } — keyStyle is "hash:index" | "hash" | "path"
const _registered = [];

/**
 * Register a Map or Set for automatic cleanup.
 * @param {string} name — human label for logging
 * @param {Map|Set} map
 * @param {"hash:index"|"hash"|"path"} keyStyle — how keys relate to infoHash
 */
export function registerCache(name, map, keyStyle = "hash:index") {
  _registered.push({ name, map, keyStyle });
}

/**
 * Remove all entries for a given infoHash across every registered cache.
 * For "path"-keyed caches (probeCache), supply file paths to delete.
 * @param {string} infoHash
 * @param {string[]} [filePaths] — required for path-keyed caches
 */
export function cleanupHash(infoHash, filePaths = []) {
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
 * @param {Set<string>} activeHashes
 * @param {function} statSync — fs.statSync, passed in to avoid importing fs here
 * @returns {number} count of pruned entries
 */
export function pruneOrphans(activeHashes, statSync) {
  let pruned = 0;
  for (const { map, keyStyle } of _registered) {
    const keys = map instanceof Set ? [...map] : [...map.keys()];
    for (const key of keys) {
      let shouldDelete = false;
      if (keyStyle === "hash:index") {
        shouldDelete = !activeHashes.has(key.split(":")[0]);
      } else if (keyStyle === "hash") {
        shouldDelete = !activeHashes.has(key);
      } else if (keyStyle === "path") {
        try { statSync(key); } catch { shouldDelete = true; }
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
 * @returns {Record<string, number>}
 */
export function cacheStats() {
  const stats = {};
  for (const { name, map } of _registered) {
    stats[name] = map.size;
  }
  return stats;
}
