import type { Express, Request, Response } from "express";
import { tmdbCache, CACHE_TTL, fetchTMDB, startCacheJanitor } from "../lib/cache/cache.js";
import { tmdbConfigured, saveTmdbKey, deleteTmdbKey } from "../lib/tmdb-config.js";
import type { ServerContext } from "../lib/types.js";

interface RedditThread {
  id: string;
  title: string;
  subreddit: string;
  url: string;
  score: number;
  comments: number;
  created: number;
  isSelfPost: boolean;
  flair: string | null;
}

export default function tmdbRoutes(app: Express, ctx: ServerContext): void {
  const { log } = ctx;

  const _cacheJanitorTmdb = startCacheJanitor(log);
  if (_cacheJanitorTmdb?.unref) _cacheJanitorTmdb.unref();

  function tmdbErrorStatus(e: Error): number {
    return e.message === "TMDB_API_KEY not set" ? 503 : 502;
  }

  // ── TMDB API key configuration ──────────────────────────────────────

  app.get("/api/tmdb/status", (_req: Request, res: Response) => {
    res.json({ configured: tmdbConfigured() });
  });

  app.post("/api/tmdb/config", async (req: Request, res: Response) => {
    const { apiKey } = req.body as { apiKey?: string };
    if (!apiKey) return res.status(400).json({ error: "apiKey required" });
    try {
      const testRes = await fetch(`https://api.themoviedb.org/3/configuration?api_key=${apiKey}`,
        { signal: AbortSignal.timeout(10000) });
      if (!testRes.ok) return res.status(400).json({ error: "Invalid TMDB API key" });
    } catch {
      return res.status(400).json({ error: "Failed to verify key with TMDB" });
    }
    saveTmdbKey(apiKey);
    tmdbCache.clear();
    log("info", "TMDB API key saved");
    res.json({ ok: true });
  });

  app.delete("/api/tmdb/config", (_req: Request, res: Response) => {
    deleteTmdbKey();
    tmdbCache.clear();
    log("info", "TMDB API key removed");
    res.json({ ok: true });
  });

// Genre list (cached long — genres rarely change)
app.get("/api/tmdb/genres", async (_req: Request, res: Response) => {
  const key = "genres:all";
  const { value: cached } = tmdbCache.getStale(key);
  if (cached) return res.json(cached);
  try {
    const [movie, tv] = await Promise.all([
      fetchTMDB("/genre/movie/list"),
      fetchTMDB("/genre/tv/list"),
    ]);
    // Merge and deduplicate by id
    const seen = new Set<number>();
    const genres: { id: number; name: string }[] = [];
    for (const g of [...((movie as any).genres || []), ...((tv as any).genres || [])]) {
      if (!seen.has(g.id)) { seen.add(g.id); genres.push(g); }
    }
    genres.sort((a, b) => a.name.localeCompare(b.name));
    const result = { genres };
    tmdbCache.set(key, result, 7 * 24 * 60 * 60 * 1000); // 7 days
    res.json(result);
  } catch (e) {
    res.status(tmdbErrorStatus(e as Error)).json({ error: (e as Error).message });
  }
});

// Stale-while-revalidate: trending
app.get("/api/tmdb/trending", async (req: Request, res: Response) => {
  const page = (req.query.page as string) || "1";
  const key = `trending:${page}`;
  const { value: cached, stale } = tmdbCache.getStale(key);
  if (cached && !stale) return res.json(cached);
  if (cached && stale) {
    res.json(cached);
    fetchTMDB(`/trending/all/week?page=${page}`)
      .then((data) => tmdbCache.set(key, data, CACHE_TTL.TRENDING))
      .catch(() => {});
    return;
  }
  try {
    const data = await fetchTMDB(`/trending/all/week?page=${page}`);
    tmdbCache.set(key, data, CACHE_TTL.TRENDING);
    res.json(data);
  } catch (e) {
    res.status(tmdbErrorStatus(e as Error)).json({ error: (e as Error).message });
  }
});

// Stale-while-revalidate: discover
app.get("/api/tmdb/discover", async (req: Request, res: Response) => {
  const query = req.query as Record<string, string>;
  const { type = "movie", genre = "", page = "1", sort = "popularity.desc" } = query;
  // Cache key must incorporate ALL query params that affect TMDB's response.
  // Using sorted URLSearchParams ensures key stability regardless of param order.
  const sortedParams = new URLSearchParams(Object.entries(query).sort());
  const key = `discover:${sortedParams.toString()}`;
  let endpoint = `/discover/${type}?sort_by=${sort}&page=${page}`;
  if (genre) endpoint += `&with_genres=${genre}`;
  for (const [k, v] of Object.entries(query)) {
    if (!["type", "genre", "page", "sort"].includes(k)) endpoint += `&${k}=${v}`;
  }

  const { value: cached, stale } = tmdbCache.getStale(key);
  if (cached && !stale) return res.json(cached);
  if (cached && stale) {
    res.json(cached);
    fetchTMDB(endpoint)
      .then((data) => tmdbCache.set(key, data, CACHE_TTL.DISCOVER))
      .catch(() => {});
    return;
  }
  try {
    const data = await fetchTMDB(endpoint);
    tmdbCache.set(key, data, CACHE_TTL.DISCOVER);
    res.json(data);
  } catch (e) {
    res.status(tmdbErrorStatus(e as Error)).json({ error: (e as Error).message });
  }
});

// Stale-while-revalidate: search
app.get("/api/tmdb/search", async (req: Request, res: Response) => {
  const q = (req.query.q as string) || "";
  const page = (req.query.page as string) || "1";
  const key = `search:${q.toLowerCase()}:${page}`;
  const endpoint = `/search/multi?query=${encodeURIComponent(q)}&page=${page}`;

  const { value: cached, stale } = tmdbCache.getStale(key);
  if (cached && !stale) return res.json(cached);
  if (cached && stale) {
    res.json(cached);
    fetchTMDB(endpoint)
      .then((data) => tmdbCache.set(key, data, CACHE_TTL.SEARCH))
      .catch(() => {});
    return;
  }
  try {
    const data = await fetchTMDB(endpoint);
    tmdbCache.set(key, data, CACHE_TTL.SEARCH);
    res.json(data);
  } catch (e) {
    res.status(tmdbErrorStatus(e as Error)).json({ error: (e as Error).message });
  }
});

// Simple cache: movie details
app.get("/api/tmdb/movie/:id", async (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const key = `movie:${id}`;
  const cached = tmdbCache.get(key);
  if (cached) return res.json(cached);
  try {
    const data = await fetchTMDB(`/movie/${id}?append_to_response=credits,similar,videos`);
    tmdbCache.set(key, data, CACHE_TTL.MOVIE);
    res.json(data);
  } catch (e) {
    res.status(tmdbErrorStatus(e as Error)).json({ error: (e as Error).message });
  }
});

// Simple cache: TV season (must be before /api/tmdb/tv/:id)
app.get("/api/tmdb/tv/:id/season/:num", async (req: Request, res: Response) => {
  const { id, num } = req.params as Record<string, string>;
  const key = `tv:${id}:season:${num}`;
  const cached = tmdbCache.get(key);
  if (cached) return res.json(cached);
  try {
    const data = await fetchTMDB(`/tv/${id}/season/${num}`);
    tmdbCache.set(key, data, CACHE_TTL.SEASON);
    res.json(data);
  } catch (e) {
    res.status(tmdbErrorStatus(e as Error)).json({ error: (e as Error).message });
  }
});

// Simple cache: TV show details
app.get("/api/tmdb/tv/:id", async (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const key = `tv:${id}`;
  const cached = tmdbCache.get(key);
  if (cached) return res.json(cached);
  try {
    const data = await fetchTMDB(`/tv/${id}?append_to_response=credits,similar,videos,external_ids`);
    tmdbCache.set(key, data, CACHE_TTL.TV);
    res.json(data);
  } catch (e) {
    res.status(tmdbErrorStatus(e as Error)).json({ error: (e as Error).message });
  }
});

// ---- Reviews & Discussions ----

async function fetchRedditThreads(title: string, type: string): Promise<RedditThread[]> {
  const subreddit = type === "tv" ? "television" : "movies";
  const queries = [
    `"${title}" discussion`,
    `"${title}" official discussion`,
  ];
  const seen = new Set<string>();
  const threads: RedditThread[] = [];

  const titleLower = title.toLowerCase();

  for (const q of queries) {
    try {
      const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(q)}&restrict_sr=on&sort=relevance&t=all&limit=10`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Rattin/2.0" },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await resp.json();
      for (const child of (data?.data?.children || [])) {
        const post = child.data;
        if (seen.has(post.id)) continue;
        // Skip threads that don't mention the title (e.g. weekly megathreads bundling multiple films)
        if (!post.title.toLowerCase().includes(titleLower)) continue;
        // For TV shows, skip episode-specific discussion threads
        if (type === "tv" && /\bS\d{1,2}\s*E\d{1,2}\b/i.test(post.title)) continue;
        seen.add(post.id);
        threads.push({
          id: post.id,
          title: post.title,
          subreddit: post.subreddit_name_prefixed,
          url: `https://www.reddit.com${post.permalink}`,
          score: post.score,
          comments: post.num_comments,
          created: post.created_utc,
          isSelfPost: post.is_self,
          flair: post.link_flair_text || null,
        });
      }
    } catch {}
  }

  // Sort by relevance (score * comments gives a good proxy for engagement)
  threads.sort((a, b) => (b.score * Math.log(b.comments + 1)) - (a.score * Math.log(a.comments + 1)));
  return threads.slice(0, 10);
}

app.get("/api/reviews/:type/:id", async (req: Request, res: Response) => {
  const { type, id } = req.params as Record<string, string>;
  if (!["movie", "tv"].includes(type)) return res.status(400).json({ error: "Invalid type" });

  const key = `reviews:${type}:${id}`;
  const cached = tmdbCache.get(key);
  if (cached) return res.json(cached);

  try {
    // Get TMDB details (from cache if available) to extract title and IMDb ID
    const detailKey = type === "tv" ? `tv:${id}` : `movie:${id}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let detail: any = tmdbCache.get(detailKey);
    if (!detail) {
      const append = type === "tv" ? "external_ids" : "";
      detail = await fetchTMDB(`/${type}/${id}${append ? `?append_to_response=${append}` : ""}`);
    }

    const title: string = detail.title || detail.name || "";
    const imdbId: string | null = detail.imdb_id || detail.external_ids?.imdb_id || null;

    // Fetch TMDB reviews and Reddit threads in parallel
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [tmdbReviews, reddit] = await Promise.all([
      fetchTMDB(`/${type}/${id}/reviews?language=en-US&page=1`).catch(() => ({ results: [] })) as Promise<any>,
      fetchRedditThreads(title, type).catch(() => []),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reviews = (tmdbReviews.results || []).slice(0, 10).map((r: any) => ({
      id: r.id,
      author: r.author,
      avatar: r.author_details?.avatar_path
        ? (r.author_details.avatar_path.startsWith("/http")
          ? r.author_details.avatar_path.slice(1)
          : `https://image.tmdb.org/t/p/w45${r.author_details.avatar_path}`)
        : null,
      rating: r.author_details?.rating || null,
      content: r.content,
      created: r.created_at,
      url: r.url,
    }));

    const result = { reviews, reddit, imdbId };
    tmdbCache.set(key, result, CACHE_TTL.REVIEWS);
    res.json(result);
  } catch (e) {
    res.status(tmdbErrorStatus(e as Error)).json({ error: (e as Error).message });
  }
});

}
