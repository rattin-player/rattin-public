import type { Express, Request, Response } from "express";
import { scoreTorrent, parseTags, findEpisodeFile as findEpisodeFileFromList, findExactEpisodeFile, findLargestVideoFile, hasWrongEpisode, coversTargetSeason } from "../lib/torrent/torrent-scoring.js";
import { fmtBytes, throttle } from "../lib/media/media-utils.js";
import { getDebridProvider, setActiveDebridStream, getDebridMode } from "../lib/torrent/debrid.js";
import type { ServerContext, Torrent } from "../lib/types.js";

// In-memory cache for availability and quality checks — avoids hammering the
// plugin (and its upstream APIs) on every page load. TTL: 30 minutes.
const availCache = new Map<string, { data: unknown; ts: number }>();
const AVAIL_CACHE_TTL = 30 * 60 * 1000;
import type { SearchQuery, SearchResult as PluginSearchResult, PluginRegistry } from "../lib/plugins/types.js";

interface SearchResult {
  name: string;
  infoHash: string;
  size: number;
  seeders: number;
  leechers?: number;
  source: string;
  seasonPack?: boolean;
  fileIdx?: number;
  languages?: string[];
  hasSubs?: boolean;
  subLanguages?: string[];
  multiAudio?: boolean;
  foreignOnly?: boolean;
  qualityHint?: string;
}

export default function searchRoutes(app: Express, ctx: ServerContext): void {
  const { log, DOWNLOAD_PATH } = ctx;
  // Access ctx.client via getter (not destructured) so deferred init is visible
  const client = () => ctx.client;

const SEARCH_TIMEOUT = 10000;

// Used to seed DHT peer discovery for magnet links.
// WebTorrent does DHT lookups, but without tracker seeds the bootstrap is slow.
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://open.demonii.com:1337/announce",
];

function buildMagnet(infoHash: string, name: string): string {
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${trackers}`;
}

async function searchTVViaPlugin(
  pluginRegistry: PluginRegistry,
  title: string,
  season: number,
  episode: number,
  imdbId?: string,
): Promise<SearchResult[]> {
  const s = String(season).padStart(2, "0");
  const e = String(episode).padStart(2, "0");
  const episodeQuery = `${title} S${s}E${e}`;
  const seasonQuery = `${title} S${s}`;
  const titleQuery = title;

  const batchResults = await pluginRegistry.searchBatch([
    { query: episodeQuery, type: "tv", season, episode, imdbId },
    { query: seasonQuery, type: "tv", season, imdbId },
    { query: titleQuery, type: "tv", imdbId },
  ]);

  const [episodeResults, seasonResults, titleResults] = batchResults;
  const filteredTitleResults = titleResults.filter((r) => coversTargetSeason(r.name, season));

  const seen = new Map<string, SearchResult>();
  for (const r of [...episodeResults, ...seasonResults, ...filteredTitleResults]) {
    if (!r.infoHash) continue;
    if (hasWrongEpisode(r.name, season, episode)) continue;

    const existing = seen.get(r.infoHash);
    if (!existing || r.seeders > existing.seeders) {
      const sPad = String(Math.abs(season)).padStart(2, "0");
      const ePad = String(Math.abs(episode)).padStart(2, "0");
      const hasEp = new RegExp(`S${sPad}E${ePad}(?!\\d)`, "i").test(r.name)
        || new RegExp(`S${Math.abs(season)}E${Math.abs(episode)}(?!\\d)`, "i").test(r.name);
      const hasSsn = new RegExp(`S${s}(?!\\d)`, "i").test(r.name)
        || /complete|full.season|season.\d|all.seasons/i.test(r.name)
        || coversTargetSeason(r.name, season);
      const isSeasonPack = !hasEp && hasSsn;
      seen.set(r.infoHash, { ...r, leechers: 0, seasonPack: isSeasonPack });
    }
  }
  return [...seen.values()];
}

app.post("/api/check-availability", async (req: Request, res: Response) => {
  const { items } = req.body as { items?: Array<{ id: number; title: string; year?: string; type?: string }> };
  if (!Array.isArray(items) || items.length === 0) return res.json({ available: [] });

  // Check cache first — keyed by the first item (detail page uses single-item checks)
  const cacheKey = items.length === 1
    ? `avail:${items[0].id}:${items[0].title}:${items[0].year || ""}`
    : null;
  if (cacheKey) {
    const cached = availCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < AVAIL_CACHE_TTL) {
      return res.json(cached.data);
    }
  }

  const capped = items.slice(0, 40);
  try {
    const result = await ctx.pluginRegistry!.availability(
      capped.map((item) => ({ title: item.title, year: Number(item.year) || undefined, type: item.type || "movie" }))
    );
    const available = result.available.map((idx) => capped[idx]?.id).filter(Boolean);
    log("info", "Availability check", { requested: capped.length, available: available.length, warning: result.warning });
    const response = { available, warning: result.warning, warnings: result.warnings };
    if (cacheKey) availCache.set(cacheKey, { data: response, ts: Date.now() });
    res.json(response);
  } catch {
    // Plugin not installed or search failed — fail open (show everything)
    res.json({ available: capped.map((i) => i.id) });
  }
});


// Return scored torrent options for user selection
app.post("/api/search-streams", async (req: Request, res: Response) => {
  const { title, year, type, season, episode, imdbId } = req.body as {
    title: string; year?: number; type?: string; season?: number; episode?: number; imdbId?: string;
  };
  if (!title) return res.status(400).json({ error: "Title is required" });

  let results: SearchResult[];
  try {
    if (type === "tv" && season && episode) {
      results = await searchTVViaPlugin(ctx.pluginRegistry!, title, season, episode, imdbId);
    } else {
      const query = year ? `${title} ${year}` : title;
      results = await ctx.pluginRegistry!.search({ query, type: (type as "movie" | "tv") || "movie", imdbId });
    }
  } catch (err) {
    if ((err as Error).message === "No plugin installed") {
      return res.status(503).json({ error: "no_source" });
    }
    log("err", "Plugin search failed", { error: (err as Error).message });
    return res.status(502).json({ error: "search_failed" });
  }

  try {
    // Deduplicate by infoHash (keep the one with more seeders)
    const deduped = new Map<string, SearchResult>();
    for (const r of results) {
      const key = r.infoHash;
      const existing = deduped.get(key);
      if (!existing || r.seeders > existing.seeders) {
        deduped.set(key, r);
      }
    }

    const scored = [...deduped.values()]
      .map((r) => {
        const tags = parseTags(r.name);
        return {
          name: r.name,
          infoHash: r.infoHash,
          seeders: r.seeders,
          leechers: r.leechers,
          size: r.size,
          source: r.source,
          score: scoreTorrent(r, title, year, type || "movie"),
          tags,
          seasonPack: r.seasonPack || false,
          fileIdx: r.fileIdx,
          languages: r.languages || [],
          hasSubs: r.hasSubs || false,
          subLanguages: r.subLanguages || [],
          multiAudio: r.multiAudio || false,
          foreignOnly: r.foreignOnly || false,
          qualityHint: r.qualityHint,
        };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.seeders - a.seeders)
      .slice(0, 50);

    // Plugin provides qualityHint on each result — if all scored results are
    // low quality, surface a warning to the frontend. The app doesn't interpret
    // the value; it just passes through whatever the plugin set.
    const warning =
      scored.length > 0 && scored.every((r) => r.qualityHint === "low")
        ? "Limited quality"
        : undefined;

    // Check debrid cache availability if configured
    const debrid = getDebridProvider();
    if (debrid && scored.length > 0) {
      try {
        const hashes = scored.map((r) => r.infoHash);
        const cached = await debrid.checkCached(hashes);
        for (const r of scored) {
          if (cached.get(r.infoHash.toLowerCase())) {
            (r as typeof r & { cached?: boolean }).cached = true;
          }
        }
      } catch (err) {
        log("warn", "Debrid cache check failed", { error: (err as Error).message });
      }
    }

    res.json({ results: scored, warning });
  } catch (err) {
    log("err", "Search streams failed", { error: (err as Error).message });
    res.json({ results: [] });
  }
});

// Lightweight endpoint to poll live peer counts for loaded torrents
app.post("/api/live-peers", (req: Request, res: Response) => {
  const { infoHashes } = req.body as { infoHashes: string[] };
  if (!infoHashes || !Array.isArray(infoHashes)) {
    return res.status(400).json({ error: "infoHashes array required" });
  }
  const results: Record<string, { numPeers: number; downloadSpeed: number }> = {};
  for (const hash of infoHashes) {
    const t = client().torrents.find((t) => t.infoHash === hash);
    if (t) {
      results[hash] = { numPeers: t.numPeers, downloadSpeed: t.downloadSpeed };
    }
  }
  res.json(results);
});

interface TorrentPlayResult {
  infoHash: string;
  fileIndex: number;
  fileName: string;
  torrentName: string;
  totalSize: number;
  tags: string[];
  debridStreamKey?: string;
}

function respondWithTorrent(torrent: Torrent, season: number | undefined, episode: number | undefined, tags: string[], preferredFileIdx?: number): TorrentPlayResult | null {
  let videoFile: { file: { name: string; length: number }; index: number } | null = null;

  // If we have a preferred fileIdx from Torrentio, use it directly
  if (preferredFileIdx !== undefined && preferredFileIdx >= 0 && preferredFileIdx < torrent.files.length) {
    const f = torrent.files[preferredFileIdx];
    videoFile = { file: { name: f.name, length: f.length }, index: preferredFileIdx };
  } else if (season && episode) {
    videoFile = findEpisodeFile(torrent, season, episode);
  } else {
    videoFile = findLargestVideo(torrent);
  }

  if (!videoFile) return null;
  (torrent.files[videoFile.index] as { select(): void }).select();
  return {
    infoHash: torrent.infoHash,
    fileIndex: videoFile.index,
    fileName: videoFile.file.name,
    torrentName: torrent.name,
    totalSize: torrent.length,
    tags,
  };
}

app.post("/api/auto-play", async (req: Request, res: Response) => {
  const { type, season, episode, preferInfoHash } = req.body as {
    title: string; year?: number; type?: string; season?: number; episode?: number; imdbId?: string;
    preferInfoHash?: string;
  };

  // Same-torrent reuse: when the caller is already playing a torrent (e.g. a
  // season pack) and just wants the next episode, short-circuit and play the
  // matching file from that torrent. Only fires in native mode — debrid
  // stream swaps have invalidation semantics we don't want to touch from here.
  if (preferInfoHash && type === "tv" && season && episode && !(getDebridProvider() && getDebridMode() === "on")) {
    const existing = client().torrents.find(
      (t) => t.infoHash === preferInfoHash || t.infoHash === preferInfoHash.toLowerCase()
    );
    if (existing && existing.files && existing.files.length > 0) {
      const match = findExactEpisodeFile(existing.files, season, episode);
      if (match) {
        (existing.files[match.index] as { select(): void }).select();
        log("info", "Auto-play: reused current torrent", {
          infoHash: existing.infoHash, file: match.file.name, season, episode,
        });
        return res.json({
          infoHash: existing.infoHash,
          fileIndex: match.index,
          fileName: match.file.name,
          torrentName: existing.name,
          totalSize: existing.length,
          tags: parseTags(existing.name),
        } satisfies TorrentPlayResult);
      }
    }
  }

  // No reuse possible — caller should use /api/search-streams + /api/play-torrent
  return res.status(404).json({ error: "not_found" });
});

// Play a specific torrent by infoHash (user-selected from search-streams)
app.post("/api/play-torrent", async (req: Request, res: Response) => {
  const { infoHash, name, season, episode, fileIdx } = req.body as {
    infoHash: string; name?: string; season?: number; episode?: number; fileIdx?: number;
  };
  if (!infoHash) return res.status(400).json({ error: "infoHash is required" });

  const tags = parseTags(name || "");
  const magnet = buildMagnet(infoHash, name || "");

  // Try debrid if enabled — no WebTorrent fallback
  const debrid = getDebridProvider();
  const debridOn = debrid && getDebridMode() === "on";
  if (debridOn) {
    try {
      const stream = await debrid.unrestrict(magnet, fileIdx);
      log("info", "Play-torrent via debrid", { infoHash, filename: stream.filename });
      const debridStreamKey = setActiveDebridStream(infoHash, stream.url, stream.files, stream.links, stream.torrentId, stream.provider);
      return res.json({
        infoHash,
        fileIndex: stream.fileIndex,
        fileName: stream.filename,
        torrentName: name || stream.filename,
        totalSize: stream.filesize,
        tags,
        debridStreamKey,
      } satisfies TorrentPlayResult);
    } catch (err) {
      log("err", "Debrid failed", { infoHash, error: (err as Error).message });
      return res.status(502).json({ error: "debrid_failed" });
    }
  }

  const existing = client().torrents.find(
    (t) => t.infoHash === infoHash || t.infoHash === infoHash.toLowerCase()
  );

  try {
    if (existing) {
      if (existing.files && existing.files.length > 0) {
        const result = respondWithTorrent(existing, season, episode, tags, fileIdx);
        if (result) return res.json(result);
        // Torrent is ready but no matching video — don't wait for "ready" (it already fired)
        log("info", "Existing torrent has no matching video, retrying fresh", { infoHash: existing.infoHash });
        try { existing.destroy({ destroyStore: false }); } catch {}
      } else {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Timed out")), 30000);
          existing.on("ready", () => { clearTimeout(timeout); resolve(); });
          existing.on("error", (err) => { clearTimeout(timeout); reject(err); });
        });
        const result = respondWithTorrent(existing, season, episode, tags, fileIdx);
        if (result) return res.json(result);
        try { existing.destroy({ destroyStore: false }); } catch {}
      }
    }

    await new Promise<TorrentPlayResult>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out")), 30000);
      let torrent: Torrent;
      try {
        torrent = client().add(magnet, { path: DOWNLOAD_PATH, deselect: true });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }
      torrent.on("error", (err) => { clearTimeout(timeout); reject(err); });
      torrent.on("ready", () => {
        clearTimeout(timeout);
        torrent.on("done", () => {
          torrent.pause();
        });
        torrent.on("error", (err) => log("err", "Torrent error", { error: (err as Error).message }));
        const result = respondWithTorrent(torrent, season, episode, tags, fileIdx);
        if (!result) { reject(new Error("No video files")); return; }
        resolve(result);
      });
    }).then((data) => {
      if (!res.headersSent) res.json(data);
    }).catch((err) => {
      log("err", "Play-torrent failed", { error: (err as Error).message });
      if (!res.headersSent) res.status(500).json({ error: "stream_failed" });
    });
  } catch (err) {
    log("err", "Play-torrent failed", { error: (err as Error).message });
    if (!res.headersSent) res.status(500).json({ error: "stream_failed" });
  }
});

function findLargestVideo(torrent: Torrent) {
  return findLargestVideoFile(torrent.files);
}

function findEpisodeFile(torrent: Torrent, season: number, episode: number) {
  return findEpisodeFileFromList(torrent.files, season, episode);
}

}
