import { tmdbCache, CACHE_TTL, fetchTMDB, startCacheJanitor } from "../lib/cache.js";

export default function tmdbRoutes(app, ctx) {
  const { log } = ctx;

  const _cacheJanitorTmdb = startCacheJanitor(log);
  if (_cacheJanitorTmdb?.unref) _cacheJanitorTmdb.unref();

  function tmdbErrorStatus(e) {
    return e.message === "TMDB_API_KEY not set" ? 503 : 502;
  }

// Stale-while-revalidate: trending
app.get("/api/tmdb/trending", async (req, res) => {
  const page = req.query.page || 1;
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
    res.status(tmdbErrorStatus(e)).json({ error: e.message });
  }
});

// Stale-while-revalidate: discover
app.get("/api/tmdb/discover", async (req, res) => {
  const { type = "movie", genre = "", page = 1, sort = "popularity.desc" } = req.query;
  // Cache key must incorporate ALL query params that affect TMDB's response.
  // Using sorted URLSearchParams ensures key stability regardless of param order.
  const sortedParams = new URLSearchParams(Object.entries(req.query).sort());
  const key = `discover:${sortedParams.toString()}`;
  let endpoint = `/discover/${type}?sort_by=${sort}&page=${page}`;
  if (genre) endpoint += `&with_genres=${genre}`;
  for (const [k, v] of Object.entries(req.query)) {
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
    res.status(tmdbErrorStatus(e)).json({ error: e.message });
  }
});

// Stale-while-revalidate: search
app.get("/api/tmdb/search", async (req, res) => {
  const q = req.query.q || "";
  const page = req.query.page || 1;
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
    res.status(tmdbErrorStatus(e)).json({ error: e.message });
  }
});

// Simple cache: movie details
app.get("/api/tmdb/movie/:id", async (req, res) => {
  const key = `movie:${req.params.id}`;
  const cached = tmdbCache.get(key);
  if (cached) return res.json(cached);
  try {
    const data = await fetchTMDB(`/movie/${req.params.id}?append_to_response=credits,similar,videos`);
    tmdbCache.set(key, data, CACHE_TTL.MOVIE);
    res.json(data);
  } catch (e) {
    res.status(tmdbErrorStatus(e)).json({ error: e.message });
  }
});

// Simple cache: TV season (must be before /api/tmdb/tv/:id)
app.get("/api/tmdb/tv/:id/season/:num", async (req, res) => {
  const key = `tv:${req.params.id}:season:${req.params.num}`;
  const cached = tmdbCache.get(key);
  if (cached) return res.json(cached);
  try {
    const data = await fetchTMDB(`/tv/${req.params.id}/season/${req.params.num}`);
    tmdbCache.set(key, data, CACHE_TTL.SEASON);
    res.json(data);
  } catch (e) {
    res.status(tmdbErrorStatus(e)).json({ error: e.message });
  }
});

// Simple cache: TV show details
app.get("/api/tmdb/tv/:id", async (req, res) => {
  const key = `tv:${req.params.id}`;
  const cached = tmdbCache.get(key);
  if (cached) return res.json(cached);
  try {
    const data = await fetchTMDB(`/tv/${req.params.id}?append_to_response=credits,similar,videos,external_ids`);
    tmdbCache.set(key, data, CACHE_TTL.TV);
    res.json(data);
  } catch (e) {
    res.status(tmdbErrorStatus(e)).json({ error: e.message });
  }
});

// ---- Reviews & Discussions ----

async function fetchRedditThreads(title, type) {
  const subreddit = type === "tv" ? "television" : "movies";
  const queries = [
    `"${title}" discussion`,
    `"${title}" official discussion`,
  ];
  const seen = new Set();
  const threads = [];

  const titleLower = title.toLowerCase();

  for (const q of queries) {
    try {
      const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(q)}&restrict_sr=on&sort=relevance&t=all&limit=10`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "MagnetPlayer/2.0" },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const child of (data?.data?.children || [])) {
        const post = child.data;
        if (seen.has(post.id)) continue;
        // Skip threads that don't mention the title (e.g. weekly megathreads bundling multiple films)
        if (!post.title.toLowerCase().includes(titleLower)) continue;
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

app.get("/api/reviews/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  if (!["movie", "tv"].includes(type)) return res.status(400).json({ error: "Invalid type" });

  const key = `reviews:${type}:${id}`;
  const cached = tmdbCache.get(key);
  if (cached) return res.json(cached);

  try {
    // Get TMDB details (from cache if available) to extract title and IMDb ID
    const detailKey = type === "tv" ? `tv:${id}` : `movie:${id}`;
    let detail = tmdbCache.get(detailKey);
    if (!detail) {
      const append = type === "tv" ? "external_ids" : "";
      detail = await fetchTMDB(`/${type}/${id}${append ? `?append_to_response=${append}` : ""}`);
    }

    const title = detail.title || detail.name || "";
    const imdbId = detail.imdb_id || detail.external_ids?.imdb_id || null;

    // Fetch TMDB reviews and Reddit threads in parallel
    const [tmdbReviews, reddit] = await Promise.all([
      fetchTMDB(`/${type}/${id}/reviews?language=en-US&page=1`).catch(() => ({ results: [] })),
      fetchRedditThreads(title, type).catch(() => []),
    ]);

    const reviews = (tmdbReviews.results || []).slice(0, 10).map((r) => ({
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
    res.status(tmdbErrorStatus(e)).json({ error: e.message });
  }
});

}
