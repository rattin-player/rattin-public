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
  needsTranscode, isAllowedFile,
} from "./lib/media-utils.js";
import { createContext } from "./lib/server-context.js";
import rcRoutes from "./routes/rc.js";
import tmdbRoutes from "./routes/tmdb.js";
import mediaRoutes from "./routes/media.js";
import statusRoutes from "./routes/status.js";
import searchRoutes from "./routes/search.js";
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
statusRoutes(app, ctx);
searchRoutes(app, ctx);

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
