// Cache key conventions (for consuming code):
//   trending:${page}
//   discover:${type}:${genre}:${page}
//   search:${query.toLowerCase()}:${page}
//   movie:${id}
//   tv:${id}
//   tv:${tvId}:season:${num}
//   genres

const DEFAULT_MAX_ENTRIES = 500;
const EVICT_RATIO = 0.2;

export class TTLCache {
  constructor(defaultTTL = 60000, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this._defaultTTL = defaultTTL;
    this._maxEntries = maxEntries;
    this._map = new Map(); // key -> { value, expiry }
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this._map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  getStale(key) {
    const entry = this._map.get(key);
    if (!entry) return { value: undefined, stale: false };
    return { value: entry.value, stale: Date.now() > entry.expiry };
  }

  set(key, value, ttl) {
    this._map.set(key, { value, expiry: Date.now() + (ttl ?? this._defaultTTL) });
    if (this._map.size > this._maxEntries) this._evict();
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  clear() {
    this._map.clear();
  }

  get size() {
    return this._map.size;
  }

  purgeExpired() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this._map) {
      if (now > entry.expiry) {
        this._map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  stats() {
    return { entries: this._map.size, maxEntries: this._maxEntries };
  }

  _evict() {
    const sorted = [...this._map.entries()].sort((a, b) => a[1].expiry - b[1].expiry);
    const count = Math.ceil(this._maxEntries * EVICT_RATIO);
    for (let i = 0; i < count; i++) sorted[i] && this._map.delete(sorted[i][0]);
  }
}

export const CACHE_TTL = {
  MOVIE:    24 * 60 * 60 * 1000,
  TV:        6 * 60 * 60 * 1000,
  SEASON:    6 * 60 * 60 * 1000,
  GENRES:    7 * 24 * 60 * 60 * 1000,
  TRENDING:  1 * 60 * 60 * 1000,
  DISCOVER:  2 * 60 * 60 * 1000,
  SEARCH:   30 * 60 * 1000,
  REVIEWS:   6 * 60 * 60 * 1000,
};

export async function fetchTMDB(path) {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY not set");
  const url = `https://api.themoviedb.org/3${path}${path.includes("?") ? "&" : "?"}api_key=${key}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "MagnetPlayer/2.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`TMDB API error: ${res.status}`);
  return res.json();
}

export const tmdbCache = new TTLCache();

export function startCacheJanitor(logFn) {
  return setInterval(() => {
    const removed = tmdbCache.purgeExpired();
    const { entries } = tmdbCache.stats();
    if (logFn && removed > 0) logFn("info", `Cache purge: removed ${removed} expired entries, ${entries} remain`);
  }, 10 * 60 * 1000);
}
