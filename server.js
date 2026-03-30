import express from "express";
import path from "path";
import fs from "fs";
import { createReadStream, statSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { tmdbCache } from "./lib/cache.js";
import { buildSeekIndex, findSeekOffset, waitForPieces, getSeekByteRange } from "./lib/seek-index.js";
import { jobKey, pruneOrphans, cacheStats } from "./lib/torrent-caches.js";
import { getFileOffset, getFileEndPiece, hasPiece } from "./lib/torrent-compat.js";
import { createIdleTracker } from "./lib/idle-tracker.js";
import {
  VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, SUBTITLE_EXTENSIONS,
  ALLOWED_EXTENSIONS, BROWSER_NATIVE,
  needsTranscode, isAllowedFile, magnetToInfoHash, fmtBytes, throttle,
} from "./lib/media-utils.js";
import {
  scoreTorrent, parseTags, matchEpisodePattern,
  findEpisodeFile as findEpisodeFileFromList, findLargestVideoFile,
} from "./lib/torrent-scoring.js";
import { createContext } from "./lib/server-context.js";
import rcRoutes from "./routes/rc.js";
import tmdbRoutes from "./routes/tmdb.js";
import mediaRoutes from "./routes/media.js";
import {
  probeMedia as _probeMedia, startTranscode as _startTranscode,
  serveFile, serveFromTorrent, serveLiveTranscode as _serveLiveTranscode,
  buildTranscodeArgs, spawnWatchdog,
} from "./lib/transcode.js";

export function createApp(overrides = {}) {
  const __dirname = overrides.__dirname || path.dirname(fileURLToPath(import.meta.url));
  const app = express();
  const ctx = createContext(overrides);
  const {
    client, DOWNLOAD_PATH, TRANSCODE_PATH,
    transcodeJobs, durationCache, seekIndexCache, seekIndexPending,
    activeFiles, completedFiles, streamTracker, activeTranscodes,
    availabilityCache, AVAIL_TTL, introCache, probeCache, pcAuthToken,
    log, diskPath, isFileComplete, cleanupTorrentCaches, streamTracking,
    rcSessions,
  } = ctx;

const probeMedia = (filePath) => _probeMedia(filePath, probeCache, log);
const startTranscode = (inputPath, cacheKey, audioStreamIdx) =>
  _startTranscode(inputPath, cacheKey, ctx, audioStreamIdx);

app.use(express.json());
app.use((req, res, next) => {
  req.cookies = {};
  const hdr = req.headers.cookie;
  if (hdr) hdr.split(";").forEach((c) => {
    const [k, ...v] = c.trim().split("=");
    if (k) req.cookies[k] = decodeURIComponent(v.join("="));
  });
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// ── Idle detection — escalating cleanup when app is unused ──
const idleTracker = createIdleTracker({
  logFn: log,
  onSoftIdle() {
    // Purge expired TMDB entries
    tmdbCache.purgeExpired();
    // Destroy torrents that have no active streams
    for (const torrent of [...client.torrents]) {
      const st = streamTracker.get(torrent.infoHash);
      if (!st || st.count === 0) {
        cleanupTorrentCaches(torrent.infoHash, torrent);
        log("info", "Soft idle: removing unstreamed torrent", { name: torrent.name });
        torrent.destroy({ destroyStore: false });
        if (st?.idleTimer) clearTimeout(st.idleTimer);
        streamTracker.delete(torrent.infoHash);
      }
    }
  },
  onHardIdle() {
    // Nuclear option: clear everything
    for (const [, job] of transcodeJobs) if (job.process && !job.done) job.process.kill();
    transcodeJobs.clear();
    durationCache.clear();
    seekIndexCache.clear();
    seekIndexPending.clear();
    activeFiles.clear();
    availabilityCache.clear();
    tmdbCache.clear();
    for (const [, st] of streamTracker) { if (st.idleTimer) clearTimeout(st.idleTimer); }
    streamTracker.clear();
    probeCache.clear();
    introCache.clear();
    for (const torrent of [...client.torrents]) {
      log("info", "Hard idle: removing torrent", { name: torrent.name });
      torrent.destroy({ destroyStore: false });
    }
    log("info", "Hard idle cleanup complete");
  },
});
app.use("/api", idleTracker.middleware);
idleTracker.start();

rcRoutes(app, ctx);
tmdbRoutes(app, ctx);
mediaRoutes(app, ctx);

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (!req.url.startsWith("/api/status") && !req.url.startsWith("/api/rc/")) {
      log("info", `${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});

// Stream endpoint
app.get("/api/stream/:infoHash/:fileIndex", streamTracking, async (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);

  // Torrent removed but file still on disk — serve directly
  if (!torrent) {
    const fileKey = `${req.params.infoHash}:${req.params.fileIndex}`;
    const cached = completedFiles.get(fileKey);
    if (cached) {
      try {
        const stat = statSync(cached.path);
        if (stat.size === cached.size) {
          const ext = path.extname(cached.name).toLowerCase();
          log("info", "Serving from disk (torrent removed)", { file: cached.name });
          if (needsTranscode(ext)) {
            return _serveLiveTranscode({
              inputPath: cached.path,
              useStdin: false,
              seekTo: parseFloat(req.query.t) || 0,
              audioStreamIdx: req.query.audio ? parseInt(req.query.audio, 10) : null,
              streamKey: null,
            }, req, res, ctx);
          }
          return serveFile(cached.path, cached.size,
            ext === ".webm" ? "video/webm" : "video/mp4", req, res);
        }
      } catch {}
      completedFiles.delete(fileKey);
    }
    return res.status(404).json({ error: "Torrent not found" });
  }

  const file = torrent.files[parseInt(req.params.fileIndex, 10)];
  if (!file) return res.status(404).json({ error: "File not found" });

  if (!isAllowedFile(file.name)) {
    return res.status(403).json({ error: "File type not allowed" });
  }

  const ext = path.extname(file.name).toLowerCase();
  const fileIdx = parseInt(req.params.fileIndex, 10);
  const audioStreamIdx = req.query.audio ? parseInt(req.query.audio, 10) : null;

  // Helper: call unified serveLiveTranscode with torrent context
  const liveTranscode = (isComplete, seek) => _serveLiveTranscode({
    inputPath: diskPath(torrent, file),
    useStdin: !isComplete,
    createInputStream: !isComplete ? () => file.createReadStream() : undefined,
    seekTo: seek,
    audioStreamIdx,
    streamKey: `${torrent.infoHash}:${fileIdx}`,
  }, req, res, ctx);

  // Kill any previous live transcode for this file (e.g. from before a seek).
  // When the frontend seeks, it sets v.src to a new URL — but the old HTTP
  // connection may not close promptly (nginx keep-alive, browser timing),
  // leaving a zombie ffmpeg process consuming CPU.
  const streamKey = `${torrent.infoHash}:${fileIdx}`;
  const prev = activeTranscodes.get(streamKey);
  if (prev) {
    log("info", "Killing previous transcode for new stream request", { streamKey });
    prev.cleanup();
    activeTranscodes.delete(streamKey);
  }

  // Ensure this file is selected and prioritized
  file.select();
  // Deselect other files so bandwidth goes to the requested file
  torrent.files.forEach((f, i) => {
    if (i !== fileIdx && f.length > 0) {
      try { f.deselect(); } catch {}
    }
  });

  const complete = isFileComplete(torrent, file);
  const filePath = diskPath(torrent, file);

  // Verify file is real media — only when complete.
  // INVARIANT: probeMedia caches successes permanently. Calling on partial files
  // would either hang ffprobe or return a transient failure that won't be retried.
  const cacheKey = jobKey(torrent.infoHash, req.params.fileIndex);

  if (complete) {
    try {
      const probe = await probeMedia(filePath);
      if (!probe.valid) {
        log("warn", "Blocked fake media file", { name: file.name, reason: probe.reason });
        return res.status(403).json({ error: "File failed media verification: " + probe.reason });
      }
      // Cache duration from probe so it's immediately available
      if (probe.duration > 0 && !durationCache.has(cacheKey)) {
        durationCache.set(cacheKey, probe.duration);
      }
    } catch {}
  }
  const xcode = needsTranscode(ext);

  // 1) Transcoded MP4 ready - serve it (full seeking works)
  if (xcode) {
    const job = transcodeJobs.get(cacheKey);
    if (job && job.done && !job.error) {
      const stat = statSync(job.outputPath);
      log("info", "Serving transcoded MP4", { file: file.name });
      return serveFile(job.outputPath, stat.size, "video/mp4", req, res);
    }
    if (job && job.error) return res.status(500).json({ error: "Transcode failed" });
  }

  // 2) Native format, complete on disk — but if non-default audio requested, force transcode
  if (complete && !xcode && audioStreamIdx === null) {
    log("info", "Serving from disk", { file: file.name });
    return serveFile(diskPath(torrent, file), file.length,
      ext === ".webm" ? "video/webm" : "video/mp4", req, res);
  }
  if (complete && !xcode && audioStreamIdx !== null) {
    log("info", "Serving with audio track override", { file: file.name, audioStreamIdx });
    return _serveLiveTranscode({
      inputPath: diskPath(torrent, file),
      useStdin: false,
      seekTo: parseFloat(req.query.t) || 0,
      audioStreamIdx,
      streamKey: `${torrent.infoHash}:${fileIdx}`,
    }, req, res, ctx);
  }

  // 3) Needs transcode but not ready yet - live pipe through ffmpeg
  if (xcode) {
    const seekTo = parseFloat(req.query.t) || 0;

    // Build seek index in background (for complete files only — incomplete files have gaps)
    if (!seekIndexCache.has(cacheKey) && !seekIndexPending.has(cacheKey) && complete) {
      seekIndexPending.add(cacheKey);
      buildSeekIndex(diskPath(torrent, file)).then((index) => {
        seekIndexPending.delete(cacheKey);
        if (index.length > 0) {
          seekIndexCache.set(cacheKey, index);
          log("info", "Seek index built", { cacheKey, keyframes: index.length });
        }
      }).catch((err) => {
        seekIndexPending.delete(cacheKey);
        log("warn", "Seek index build failed", { cacheKey, error: err.message });
      });
    }

    // Smart seek: check if pieces at seek target are on disk → use fast disk read
    if (seekTo > 0) {
      // Determine byte offset for the seek target
      let byteStart = null;

      // Method 1: precise keyframe index (available for complete files)
      if (seekIndexCache.has(cacheKey)) {
        const seekPoint = findSeekOffset(seekIndexCache.get(cacheKey), seekTo);
        if (seekPoint) byteStart = seekPoint.offset;
      }

      // Method 2: estimate from duration (works for any file with known duration)
      if (byteStart === null) {
        const dur = durationCache.get(cacheKey);
        if (dur && dur > 0) {
          byteStart = Math.floor((seekTo / dur) * file.length);
        }
      }

      if (byteStart !== null) {
        const byteEnd = Math.min(byteStart + 10 * 1024 * 1024, file.length - 1);
        const pieceLength = torrent.pieceLength;
        const fileOffset = getFileOffset(file);
        const firstPiece = Math.floor((fileOffset + byteStart) / pieceLength);
        const lastPiece = Math.floor((fileOffset + byteEnd) / pieceLength);

        // Check if pieces are already on disk
        let piecesReady = true;
        for (let i = firstPiece; i <= lastPiece; i++) {
          if (!hasPiece(torrent, i)) { piecesReady = false; break; }
        }

        if (piecesReady) {
          // Fast path: pieces on disk → input seeking + copy mode (near-instant)
          log("info", "Smart seek (instant)", { seekTo, byteStart, method: seekIndexCache.has(cacheKey) ? "index" : "estimate" });
          torrent.select(firstPiece, getFileEndPiece(file), 1);
          return liveTranscode(true, seekTo);
        }

        // Pieces not ready — fetch them, then use fast path
        log("info", "Smart seek (fetching)", { seekTo, byteStart });
        const doSmartSeek = async () => {
          try {
            await waitForPieces(torrent, file, byteStart, byteEnd, 30000);
            torrent.select(firstPiece, getFileEndPiece(file), 1);
            return liveTranscode(true, seekTo);
          } catch {
            log("warn", "Smart seek timeout, falling back", { seekTo });
            return liveTranscode(complete, seekTo);
          }
        };
        return doSmartSeek();
      }
    }

    log("info", "Live transcode", { file: file.name, complete, seekTo });
    return liveTranscode(complete, seekTo);
  }

  // 4) Native format, still downloading - WebTorrent stream
  log("info", "Streaming via WebTorrent", { file: file.name });
  serveFromTorrent(file, req, res);
});


// Status
app.get("/api/status/:infoHash", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) {
    const diskFiles = [];
    for (const [key, info] of completedFiles) {
      if (key.startsWith(req.params.infoHash + ":")) {
        const idx = parseInt(key.split(":")[1], 10);
        const ext = path.extname(info.name).toLowerCase();
        diskFiles.push({
          index: idx, name: info.name, length: info.size,
          downloaded: info.size, progress: 1,
          isVideo: VIDEO_EXTENSIONS.includes(ext),
          isAudio: AUDIO_EXTENSIONS.includes(ext),
          isSubtitle: SUBTITLE_EXTENSIONS.includes(ext),
          isAllowed: isAllowedFile(info.name),
          transcodeStatus: null, duration: durationCache.get(key) || null,
        });
      }
    }
    if (diskFiles.length > 0) {
      return res.json({
        infoHash: req.params.infoHash, name: "(cached on disk)",
        downloadSpeed: 0, uploadSpeed: 0, progress: 1,
        downloaded: 0, totalSize: 0, numPeers: 0, timeRemaining: 0,
        files: diskFiles,
      });
    }
    return res.status(404).json({ error: "Torrent not found" });
  }

  res.json({
    infoHash: torrent.infoHash,
    name: torrent.name,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    progress: torrent.progress,
    downloaded: torrent.downloaded,
    totalSize: torrent.length,
    numPeers: torrent.numPeers,
    timeRemaining: torrent.timeRemaining,
    files: torrent.files.map((f, i) => {
      const ext = path.extname(f.name).toLowerCase();
      const key = jobKey(torrent.infoHash, i);
      const job = transcodeJobs.get(key);
      let transcodeStatus = null;
      if (needsTranscode(ext) && VIDEO_EXTENSIONS.includes(ext)) {
        if (job && job.done && !job.error) transcodeStatus = "ready";
        else if (job && job.error) transcodeStatus = "error";
        else if (job) transcodeStatus = "transcoding";
        else transcodeStatus = "pending";
      }
      return {
        index: i, name: f.name, length: f.length,
        downloaded: f.downloaded,
        progress: f.length > 0 ? f.downloaded / f.length : 0,
        isVideo: VIDEO_EXTENSIONS.includes(ext),
        isAudio: AUDIO_EXTENSIONS.includes(ext),
        isSubtitle: SUBTITLE_EXTENSIONS.includes(ext),
        isAllowed: isAllowedFile(f.name),
        transcodeStatus,
        duration: durationCache.get(key) || null,
      };
    }),
  });
});




// Pause all other torrents, resume this one
app.post("/api/set-active/:infoHash", (req, res) => {
  const activeHash = req.params.infoHash;
  for (const t of client.torrents) {
    if (t.infoHash === activeHash) {
      if (t.paused) t.resume();
    } else if (t.progress < 1 && !t.paused) {
      t.pause();
      log("info", "Paused inactive torrent", { name: t.name });
    }
  }
  res.json({ ok: true });
});

function torrentInfo(torrent) {
  const blocked = [];
  const files = torrent.files.map((f, i) => {
    const ext = path.extname(f.name).toLowerCase();
    const allowed = isAllowedFile(f.name);
    if (!allowed) blocked.push(f.name);
    return {
      index: i, name: f.name, length: f.length,
      isVideo: VIDEO_EXTENSIONS.includes(ext),
      isAudio: AUDIO_EXTENSIONS.includes(ext),
      isSubtitle: SUBTITLE_EXTENSIONS.includes(ext),
      isAllowed: allowed,
    };
  });
  if (blocked.length > 0) {
    log("info", "Blocked non-media files", { count: blocked.length, examples: blocked.slice(0, 5) });
  }
  return { infoHash: torrent.infoHash, name: torrent.name, files };
}


// ---- Auto-Play Endpoint ----

const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.bittor.pw:1337/announce",
  "udp://public.popcorn-tracker.org:6969/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://exodus.desync.com:6969",
  "udp://open.demonii.com:1337/announce",
];

async function searchTPB(query) {
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "MagnetPlayer/2.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (Array.isArray(data) ? data : [])
    .filter((r) => r.id !== "0" && r.name !== "No results returned")
    .map((r) => ({
      name: r.name,
      infoHash: (r.info_hash || "").toLowerCase(),
      size: parseInt(r.size, 10) || 0,
      seeders: parseInt(r.seeders, 10) || 0,
      leechers: parseInt(r.leechers, 10) || 0,
      source: "tpb",
    }));
}

async function searchEZTV(query, imdbId) {
  if (!imdbId) return [];
  // EZTV API requires IMDB ID (numeric part only)
  const numericId = imdbId.replace(/\D/g, "");
  if (!numericId) return [];
  try {
    const results = [];
    // Fetch up to 3 pages to get good coverage
    for (let page = 1; page <= 3; page++) {
      const url = `https://eztvx.to/api/get-torrents?imdb_id=${numericId}&limit=100&page=${page}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "MagnetPlayer/2.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) break;
      const data = await resp.json();
      if (!data.torrents || data.torrents.length === 0) break;
      for (const t of data.torrents) {
        results.push({
          name: t.title || t.filename,
          infoHash: (t.hash || "").toLowerCase(),
          size: parseInt(t.size_bytes, 10) || 0,
          seeders: parseInt(t.seeds, 10) || 0,
          leechers: parseInt(t.peers, 10) || 0,
          source: "eztv",
        });
      }
      if (data.torrents.length < 100) break;
    }
    // Filter by query terms (to match specific episode)
    const terms = query.toLowerCase().split(/\s+/);
    return results.filter((r) => {
      const name = r.name.toLowerCase();
      return terms.every((term) => name.includes(term));
    });
  } catch {
    return [];
  }
}

async function searchYTS(query) {
  try {
    const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=20&sort_by=seeds`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "MagnetPlayer/2.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.data?.movies) return [];
    const results = [];
    for (const movie of data.data.movies) {
      for (const torrent of (movie.torrents || [])) {
        results.push({
          name: `${movie.title_long} ${torrent.quality} ${torrent.type}`.trim(),
          infoHash: (torrent.hash || "").toLowerCase(),
          size: parseInt(torrent.size_bytes, 10) || 0,
          seeders: parseInt(torrent.seeds, 10) || 0,
          leechers: parseInt(torrent.peers, 10) || 0,
          source: "yts",
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function searchTorrents(query, imdbId) {
  const [tpb, eztv, yts] = await Promise.allSettled([
    searchTPB(query),
    searchEZTV(query, imdbId),
    searchYTS(query),
  ]);

  const all = [
    ...(tpb.status === "fulfilled" ? tpb.value : []),
    ...(eztv.status === "fulfilled" ? eztv.value : []),
    ...(yts.status === "fulfilled" ? yts.value : []),
  ];

  // Dedupe by infoHash, keep the one with more seeders
  const seen = new Map();
  for (const r of all) {
    if (!r.infoHash) continue;
    const existing = seen.get(r.infoHash);
    if (!existing || r.seeders > existing.seeders) {
      seen.set(r.infoHash, r);
    }
  }

  const merged = [...seen.values()];
  log("info", "Multi-provider search", {
    query,
    tpb: tpb.status === "fulfilled" ? tpb.value.length : 0,
    eztv: eztv.status === "fulfilled" ? eztv.value.length : 0,
    yts: yts.status === "fulfilled" ? yts.value.length : 0,
    merged: merged.length,
  });

  return merged;
}


// ---- Availability Check ----

async function checkOneAvailability(title, year, type) {
  const cacheKey = `${title.toLowerCase()}:${year || ""}`;
  const cached = availabilityCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AVAIL_TTL) return cached.available;

  const query = year ? `${title} ${year}` : title;
  try {
    const results = await searchTorrents(query);
    const hasMatch = results.some((r) => scoreTorrent(r, title, year, type) > 0);
    availabilityCache.set(cacheKey, { available: hasMatch, ts: Date.now() });
    return hasMatch;
  } catch {
    return false;
  }
}

async function runPool(tasks, concurrency) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

app.post("/api/check-availability", async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.json({ available: [] });

  const capped = items.slice(0, 40);
  const tasks = capped.map((item) => () =>
    checkOneAvailability(item.title, item.year, item.type).then((ok) => ok ? item.id : null)
  );

  try {
    const results = await runPool(tasks, 6);
    const available = results.filter(Boolean);
    log("info", "Availability check", { requested: capped.length, available: available.length });
    res.json({ available });
  } catch (err) {
    log("err", "Availability check failed", { error: err.message });
    res.json({ available: capped.map((i) => i.id) }); // fail open — show everything
  }
});


async function searchTV(title, season, episode, imdbId) {
  const s = String(season).padStart(2, "0");
  const e = String(episode).padStart(2, "0");
  const episodeQuery = `${title} S${s}E${e}`;
  const seasonQuery = `${title} S${s}`;

  const [episodeResults, seasonResults] = await Promise.all([
    searchTorrents(episodeQuery, imdbId),
    searchTorrents(seasonQuery, imdbId),
  ]);

  // Dedupe
  const seen = new Map();
  for (const r of [...episodeResults, ...seasonResults]) {
    if (!r.infoHash) continue;
    const existing = seen.get(r.infoHash);
    if (!existing || r.seeders > existing.seeders) {
      // Mark season packs (name contains S01 but not S01E01)
      const hasEpisode = new RegExp(`S${s}E${e}(?!\\d)`, "i").test(r.name)
        || new RegExp(`S${season}E${episode}(?!\\d)`, "i").test(r.name);
      const hasSeason = new RegExp(`S${s}(?!\\d)`, "i").test(r.name)
        || /complete|full.season|season.\d/i.test(r.name);
      const isSeasonPack = !hasEpisode && hasSeason;
      seen.set(r.infoHash, { ...r, seasonPack: isSeasonPack });
    }
  }
  return [...seen.values()];
}

// Return scored torrent options for user selection
app.post("/api/search-streams", async (req, res) => {
  const { title, year, type, season, episode, imdbId } = req.body;
  if (!title) return res.status(400).json({ error: "Title is required" });

  let results;
  if (type === "tv" && season && episode) {
    results = await searchTV(title, season, episode, imdbId);
  } else {
    const query = year ? `${title} ${year}` : title;
    results = await searchTorrents(query, imdbId);
  }

  try {
    const scored = results
      .map((r) => ({
        name: r.name,
        infoHash: r.infoHash,
        seeders: r.seeders,
        leechers: r.leechers,
        size: r.size,
        source: r.source,
        score: scoreTorrent(r, title, year, type),
        tags: parseTags(r.name),
        seasonPack: r.seasonPack || false,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.seeders - a.seeders || b.score - a.score)
      .slice(0, 20);

    res.json({ results: scored });
  } catch (err) {
    log("err", "Search streams failed", { error: err.message });
    res.json({ results: [] });
  }
});

function respondWithTorrent(torrent, season, episode, tags) {
  const videoFile = (season && episode)
    ? findEpisodeFile(torrent, season, episode)
    : findLargestVideo(torrent);
  if (!videoFile) return null;
  videoFile.file.select();
  return {
    infoHash: torrent.infoHash,
    fileIndex: videoFile.index,
    fileName: videoFile.file.name,
    torrentName: torrent.name,
    totalSize: torrent.length,
    tags,
  };
}

app.post("/api/auto-play", async (req, res) => {
  const { title, year, type, season, episode, imdbId } = req.body;
  if (!title) return res.status(400).json({ error: "Title is required" });

  let results;
  if (type === "tv" && season && episode) {
    log("info", "Auto-play search (TV)", { title, season, episode });
    results = await searchTV(title, season, episode, imdbId);
  } else {
    const query = year ? `${title} ${year}` : title;
    log("info", "Auto-play search", { query });
    results = await searchTorrents(query, imdbId);
  }

  try {
    if (results.length === 0) {
      log("info", "Auto-play: no results");
      return res.status(404).json({ error: "not_found" });
    }

    const scored = results
      .map((r) => ({ ...r, score: scoreTorrent(r, title, year, type) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.seeders - a.seeders);

    if (scored.length === 0) {
      log("info", "Auto-play: no quality matches", { query, total: results.length });
      return res.status(404).json({ error: "not_found" });
    }

    const best = scored[0];
    log("info", "Auto-play selected", { name: best.name, score: best.score, seeders: best.seeders, source: best.source });

    const tags = parseTags(best.name);
    const trackerParams = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
    const magnet = `magnet:?xt=urn:btih:${best.infoHash}&dn=${encodeURIComponent(best.name)}${trackerParams}`;

    // Reuse existing torrent if already in client
    const existing = client.torrents.find(
      (t) => t.infoHash === best.infoHash || t.infoHash === best.infoHash.toLowerCase()
    );

    const autoSeason = type === "tv" ? season : undefined;
    const autoEpisode = type === "tv" ? episode : undefined;

    if (existing) {
      // Already ready with files — return immediately
      if (existing.files && existing.files.length > 0) {
        const result = respondWithTorrent(existing, autoSeason, autoEpisode, tags);
        if (result) return res.json(result);
        // Torrent is ready but no matching video — don't wait for "ready" (it already fired)
        log("info", "Existing torrent has no matching video, retrying fresh", { infoHash: existing.infoHash });
        try { existing.destroy({ destroyStore: false }); } catch {}
      } else {
        // Still loading metadata — wait for ready
        log("info", "Waiting for existing torrent metadata", { infoHash: existing.infoHash });
        try {
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Timed out")), 30000);
            existing.on("ready", () => { clearTimeout(timeout); resolve(); });
            existing.on("error", (err) => { clearTimeout(timeout); reject(err); });
          });
          const result = respondWithTorrent(existing, autoSeason, autoEpisode, tags);
          if (result) return res.json(result);
        } catch {}
        // If still no good, remove the stuck torrent and try fresh
        log("info", "Removing stuck torrent, retrying", { infoHash: existing.infoHash });
        try { existing.destroy({ destroyStore: false }); } catch {}
      }
    }

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for metadata")), 30000);
      let torrent;
      try {
        torrent = client.add(magnet, { path: DOWNLOAD_PATH, deselect: true });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }
      torrent.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      torrent.on("ready", () => {
        clearTimeout(timeout);

        torrent.on("download", throttle(() => {
          log("info", "Progress", {
            name: torrent.name,
            progress: (torrent.progress * 100).toFixed(1) + "%",
            down: fmtBytes(torrent.downloadSpeed) + "/s",
            peers: torrent.numPeers,
          });
        }, 10000));

        torrent.on("done", () => {
          log("info", "Download complete", { name: torrent.name });
          torrent.pause();
        });

        torrent.on("error", (err) => log("err", "Torrent error", { error: err.message }));

        const result = respondWithTorrent(torrent, autoSeason, autoEpisode, tags);
        if (!result) {
          reject(new Error("No video files found in torrent"));
          return;
        }

        resolve(result);
      });
    }).then((data) => {
      if (!res.headersSent) res.json(data);
    }).catch((err) => {
      log("err", "Auto-play torrent failed", { error: err.message });
      if (!res.headersSent) res.status(500).json({ error: "stream_failed" });
    });
  } catch (err) {
    log("err", "Auto-play failed", { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: "stream_failed" });
  }
});

// Play a specific torrent by infoHash (user-selected from search-streams)
app.post("/api/play-torrent", async (req, res) => {
  const { infoHash, name, season, episode } = req.body;
  if (!infoHash) return res.status(400).json({ error: "infoHash is required" });

  const tags = parseTags(name || "");
  const trackerParams = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name || "")}${trackerParams}`;

  const existing = client.torrents.find(
    (t) => t.infoHash === infoHash || t.infoHash === infoHash.toLowerCase()
  );

  try {
    if (existing) {
      if (existing.files && existing.files.length > 0) {
        const result = respondWithTorrent(existing, season, episode, tags);
        if (result) return res.json(result);
        // Torrent is ready but no matching video — don't wait for "ready" (it already fired)
        log("info", "Existing torrent has no matching video, retrying fresh", { infoHash: existing.infoHash });
        try { existing.destroy({ destroyStore: false }); } catch {}
      } else {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Timed out")), 30000);
          existing.on("ready", () => { clearTimeout(timeout); resolve(); });
          existing.on("error", (err) => { clearTimeout(timeout); reject(err); });
        });
        const result = respondWithTorrent(existing, season, episode, tags);
        if (result) return res.json(result);
        try { existing.destroy({ destroyStore: false }); } catch {}
      }
    }

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out")), 30000);
      let torrent;
      try {
        torrent = client.add(magnet, { path: DOWNLOAD_PATH, deselect: true });
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
        torrent.on("error", (err) => log("err", "Torrent error", { error: err.message }));
        const result = respondWithTorrent(torrent, season, episode, tags);
        if (!result) { reject(new Error("No video files")); return; }
        resolve(result);
      });
    }).then((data) => {
      if (!res.headersSent) res.json(data);
    }).catch((err) => {
      log("err", "Play-torrent failed", { error: err.message });
      if (!res.headersSent) res.status(500).json({ error: "stream_failed" });
    });
  } catch (err) {
    log("err", "Play-torrent failed", { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: "stream_failed" });
  }
});

function findLargestVideo(torrent) {
  return findLargestVideoFile(torrent.files);
}

function findEpisodeFile(torrent, season, episode) {
  return findEpisodeFileFromList(torrent.files, season, episode);
}

// Cache janitor — every 5 min, prune entries for removed torrents
const _cacheJanitor = setInterval(() => {
  const activeHashes = new Set(client.torrents.map((t) => t.infoHash));
  let pruned = pruneOrphans(activeHashes, statSync);
  // Availability cache has its own TTL — prune separately
  const now = Date.now();
  for (const [key, entry] of availabilityCache) {
    if (now - entry.ts > AVAIL_TTL) { availabilityCache.delete(key); pruned++; }
  }
  if (pruned > 0) log("info", "Cache janitor", { pruned, ...cacheStats(), availability: availabilityCache.size });
}, 5 * 60 * 1000);
if (_cacheJanitor.unref) _cacheJanitor.unref();

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

  return {
    app, client, transcodeJobs, durationCache, seekIndexCache, seekIndexPending,
    activeFiles, completedFiles, streamTracker, activeTranscodes, availabilityCache,
    probeCache, introCache, rcSessions, idleTracker, pcAuthToken,
  };
}

// Detect if this file is being run directly (not imported by tests)
const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("/server.js")
);
if (isMain) {
  const { app, client, transcodeJobs } = createApp();

  function cleanup() {
    console.log(`[${new Date().toISOString().slice(11, 23)}] INFO  Shutting down...`);
    for (const [, job] of transcodeJobs) if (job.process && !job.done) job.process.kill();
    client.destroy(() => {
      console.log(`[${new Date().toISOString().slice(11, 23)}] INFO  Stopped`);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[${new Date().toISOString().slice(11, 23)}] INFO  Rattin running at http://localhost:${PORT}`);
  });
}
