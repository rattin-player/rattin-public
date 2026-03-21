# Implementation Agent Prompt — TMDB API Cache Layer

## System Prompt

You are an expert backend engineer. You write minimal, clean Node.js code. No unnecessary abstractions. No external libraries unless they earn their weight. You're working in `/home/rattin-playert/Documents/mine/rattin`.

The backend is `server.js` — Express 5, ES modules (`"type": "module"`), Node.js.

---

## Task

Create a standalone, self-contained cache module at `lib/cache.js` that another agent building TMDB endpoints will import and use. **Do NOT touch `server.js`.** Your only deliverable is the `lib/cache.js` file.

This runs in parallel with a main refactor agent that is restructuring the entire app. That agent will import your module when it builds the TMDB proxy endpoints. To avoid merge conflicts, you write only `lib/cache.js` — nothing else.

---

## Deliverable: `lib/cache.js`

A single file that exports everything needed to cache TMDB API responses. It must export:

### 1. `TTLCache` class

```js
class TTLCache {
  constructor(defaultTTL = 60000)
  get(key)           // returns value or undefined (auto-deletes expired)
  getStale(key)      // returns { value, stale: boolean } — returns expired entries marked as stale
  set(key, value, ttl)
  has(key)
  clear()
  get size()
  purgeExpired()     // manually evict all expired entries, returns count removed
  stats()            // returns { entries: number, maxEntries: number }
}
```

Features:
- TTL-based expiry checked on read (lazy eviction)
- Hard cap at 5000 entries. When exceeded, evict the oldest 20% by expiry time (inside `set()`)
- `getStale()` for stale-while-revalidate pattern — returns the value even if expired, with a `stale: true` flag so the caller can decide to serve it while refreshing in the background

### 2. `CACHE_TTL` constants

```js
export const CACHE_TTL = {
  MOVIE:    24 * 60 * 60 * 1000,  // 24h — movie details almost never change
  TV:        6 * 60 * 60 * 1000,  // 6h  — TV shows update with new seasons/episodes
  SEASON:    6 * 60 * 60 * 1000,  // 6h  — episode lists for airing shows
  GENRES:    7 * 24 * 60 * 60 * 1000, // 7d — genre lists basically never change
  TRENDING:  1 * 60 * 60 * 1000,  // 1h  — trending shifts throughout the day
  DISCOVER:  2 * 60 * 60 * 1000,  // 2h  — discovery results change slowly
  SEARCH:   30 * 60 * 1000,       // 30m — search results are more volatile
};
```

### 3. `fetchTMDB(path)` helper

A cached-aware TMDB fetch wrapper. This is the main function the refactor agent will call.

```js
export async function fetchTMDB(path)
```

- Reads API key from `process.env.TMDB_API_KEY`
- Base URL: `https://api.themoviedb.org/3`
- Appends `api_key` query param
- Sets `User-Agent: MagnetPlayer/2.0`
- 10 second timeout via `AbortSignal.timeout(10000)`
- Throws on non-2xx response with the status code in the message
- If `TMDB_API_KEY` is not set, throws `"TMDB_API_KEY not set"`
- **This function does NOT cache.** It's a raw fetch. The caching is done by the caller using the `TTLCache` instance and the TTL constants. Keeping them separate means the caller controls cache keys and TTLs per endpoint.

### 4. `tmdbCache` — pre-instantiated cache instance

```js
export const tmdbCache = new TTLCache();
```

A ready-to-use singleton so the refactor agent just imports it.

### 5. `startCacheJanitor(logFn)` — periodic cleanup

```js
export function startCacheJanitor(logFn)
```

- Sets up a `setInterval` every 10 minutes that calls `tmdbCache.purgeExpired()`
- If `logFn` is provided, calls `logFn("info", "Cache purge: removed N expired entries, M remain")` when entries are purged
- Returns the interval ID so the caller can `clearInterval()` on shutdown if needed

---

## Cache Key Strategy (document as a comment in the file)

Add a comment block at the top of the file documenting the intended key conventions for the consuming agent:

```
// Cache key conventions (for consuming code):
//   trending:${page}
//   discover:${type}:${genre}:${page}
//   search:${query.toLowerCase()}:${page}
//   movie:${id}
//   tv:${id}
//   tv:${tvId}:season:${num}
//   genres
```

---

## Usage Example (document as a comment at the bottom of the file)

```js
// Usage in server.js TMDB endpoints:
//
// import { tmdbCache, CACHE_TTL, fetchTMDB, startCacheJanitor } from "./lib/cache.js";
//
// startCacheJanitor(log); // pass your log function
//
// // Simple cache pattern (movie details, TV details, genres, seasons):
// app.get("/api/tmdb/movie/:id", async (req, res) => {
//   const key = `movie:${req.params.id}`;
//   const cached = tmdbCache.get(key);
//   if (cached) return res.json(cached);
//   const data = await fetchTMDB(`/movie/${req.params.id}?append_to_response=credits,similar,videos`);
//   tmdbCache.set(key, data, CACHE_TTL.MOVIE);
//   res.json(data);
// });
//
// // Stale-while-revalidate pattern (trending, discover, search):
// app.get("/api/tmdb/trending", async (req, res) => {
//   const key = `trending:${req.query.page || 1}`;
//   const { value: cached, stale } = tmdbCache.getStale(key);
//   if (cached && !stale) return res.json(cached);
//   if (cached && stale) {
//     res.json(cached);
//     fetchTMDB(`/trending/all/week?page=${req.query.page || 1}`)
//       .then(data => tmdbCache.set(key, data, CACHE_TTL.TRENDING))
//       .catch(() => {});
//     return;
//   }
//   const data = await fetchTMDB(`/trending/all/week?page=${req.query.page || 1}`);
//   tmdbCache.set(key, data, CACHE_TTL.TRENDING);
//   res.json(data);
// });
```

---

## What NOT to Do

- Do NOT touch `server.js` — another agent owns that file
- Do NOT install any npm packages — this is pure JS, zero dependencies
- Do NOT create any other files besides `lib/cache.js`
- Do NOT persist cache to disk
- Do NOT add TypeScript
- Do NOT over-engineer — the entire file should be under 120 lines
