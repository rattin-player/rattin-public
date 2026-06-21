// Cache key conventions (for consuming code):
//   trending:${page}
//   discover:${type}:${genre}:${page}
//   search:${query.toLowerCase()}:${page}
//   movie:${id}
//   tv:${id}
//   tv:${tvId}:season:${num}
//   genres

import type { StaleResult, CacheStats, LogFn } from "../types.js";
import { loadTmdbKey } from "../tmdb-config.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { configDir } from "../storage/paths.js";

const DEFAULT_MAX_ENTRIES = 500;
const EVICT_RATIO = 0.2;
const CACHE_FILE = path.join(configDir(), "tmdb-cache.json");

interface CacheEntry<T> {
  value: T;
  expiry: number;
}

export class TTLCache {
  private _defaultTTL: number;
  private _maxEntries: number;
  private _map: Map<string, CacheEntry<unknown>>;

  constructor(defaultTTL: number = 60000, { maxEntries = DEFAULT_MAX_ENTRIES }: { maxEntries?: number } = {}) {
    this._defaultTTL = defaultTTL;
    this._maxEntries = maxEntries;
    this._map = new Map();
  }

  get(key: string): unknown {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this._map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  getStale(key: string): StaleResult<unknown> {
    const entry = this._map.get(key);
    if (!entry) return { value: undefined, stale: false };
    return { value: entry.value, stale: Date.now() > entry.expiry };
  }

  set(key: string, value: unknown, ttl?: number): void {
    this._map.set(key, { value, expiry: Date.now() + (ttl ?? this._defaultTTL) });
    if (this._map.size > this._maxEntries) this._evict();
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this._map.clear();
  }

  get size(): number {
    return this._map.size;
  }

  purgeExpired(): number {
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

  stats(): CacheStats {
    return { entries: this._map.size, maxEntries: this._maxEntries };
  }

  /** Save cache to disk. Call on shutdown and periodically. */
  save(): void {
    try {
      const obj: Record<string, { v: unknown; e: number }> = {};
      for (const [key, entry] of this._map) {
        if (entry.expiry > Date.now()) { // only persist non-expired entries
          obj[key] = { v: entry.value, e: entry.expiry };
        }
      }
      mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(obj));
    } catch {}
  }

  /** Load cache from disk. Call on startup. */
  load(): void {
    try {
      const raw = readFileSync(CACHE_FILE, "utf8");
      const obj = JSON.parse(raw) as Record<string, { v: unknown; e: number }>;
      const now = Date.now();
      for (const [key, entry] of Object.entries(obj)) {
        if (entry.e > now) {
          this._map.set(key, { value: entry.v, expiry: entry.e });
        }
      }
    } catch {}
  }

  private _evict(): void {
    const sorted = [...this._map.entries()].sort((a, b) => a[1].expiry - b[1].expiry);
    const count = Math.ceil(this._maxEntries * EVICT_RATIO);
    for (let i = 0; i < count; i++) sorted[i] && this._map.delete(sorted[i][0]);
  }
}

export const CACHE_TTL: Record<string, number> = {
  MOVIE:    24 * 60 * 60 * 1000,
  TV:        6 * 60 * 60 * 1000,
  SEASON:    6 * 60 * 60 * 1000,
  GENRES:    7 * 24 * 60 * 60 * 1000,
  TRENDING:  24 * 60 * 60 * 1000,   // 24h — content lists don't change frequently
  DISCOVER:  24 * 60 * 60 * 1000,   // 24h
  SEARCH:   30 * 60 * 1000,
  REVIEWS:   6 * 60 * 60 * 1000,
};

// TMDB proxy URL — set via env var or .env file.
// The proxy adds the API key server-side so it's never exposed to clients.
const TMDB_PROXY_URL = process.env.TMDB_PROXY_URL || "https://rattin-tmdb.pages.dev";

export async function fetchTMDB(path: string): Promise<unknown> {
  const userKey = loadTmdbKey();

  let url: string;
  const headers: Record<string, string> = { "User-Agent": "Rattin/2.0" };

  if (userKey) {
    // User has their own TMDB key — detect format and use appropriate auth
    if (userKey.startsWith("eyJ")) {
      // v4 JWT — use Authorization header
      url = `https://api.themoviedb.org/3${path}`;
      headers["Authorization"] = `Bearer ${userKey}`;
    } else {
      // v3 API key — use query parameter
      url = `https://api.themoviedb.org/3${path}${path.includes("?") ? "&" : "?"}api_key=${userKey}`;
    }
  } else if (TMDB_PROXY_URL) {
    // Proxy configured — use it (key is added server-side by the Worker)
    url = `${TMDB_PROXY_URL}/3${path}`;
  } else {
    throw new Error("TMDB_API_KEY not set and no proxy configured");
  }

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`TMDB API error: ${res.status}`);
  return res.json();
}

export const tmdbCache = new TTLCache();

export function loadCacheFromDisk(): void {
  tmdbCache.load();
}

export function saveCacheToDisk(): void {
  tmdbCache.save();
}

export function startCacheJanitor(logFn: LogFn): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const removed = tmdbCache.purgeExpired();
    const { entries } = tmdbCache.stats();
    if (logFn && removed > 0) logFn("info", `Cache purge: removed ${removed} expired entries, ${entries} remain`);
    tmdbCache.save(); // persist to disk on each janitor cycle
  }, 10 * 60 * 1000);
}
