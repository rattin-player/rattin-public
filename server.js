import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createReadStream, statSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { tmdbCache, CACHE_TTL, fetchTMDB, startCacheJanitor } from "./lib/cache.js";
import { buildSeekIndex, findSeekOffset, waitForPieces, getSeekByteRange } from "./lib/seek-index.js";
import { jobKey, pruneOrphans, cacheStats } from "./lib/torrent-caches.js";
import { getFileOffset, getFileEndPiece, hasPiece } from "./lib/torrent-compat.js";
import { createIdleTracker } from "./lib/idle-tracker.js";
import { detectIntro, lookupExternal } from "./lib/intro-detect.js";
import {
  VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, SUBTITLE_EXTENSIONS,
  ALLOWED_EXTENSIONS, BROWSER_NATIVE,
  needsTranscode, isAllowedFile, srtToVtt, magnetToInfoHash, fmtBytes, throttle,
} from "./lib/media-utils.js";
import {
  scoreTorrent, parseTags, matchEpisodePattern,
  findEpisodeFile as findEpisodeFileFromList, findLargestVideoFile,
} from "./lib/torrent-scoring.js";
import { createContext } from "./lib/server-context.js";
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

app.get("/api/auth/persist", (req, res) => {
  // Only reachable after nginx basic auth succeeded (or a valid token).
  // Set a long-lived cookie — nginx skips basic auth when rc_auth cookie exists.
  res.setHeader("Set-Cookie",
    `rc_auth=${pcAuthToken}; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`);
  res.json({ ok: true });
});

// ── Remote Control (SSE + REST relay) ──────────────────────────────────

function rcSession(id) {
  const s = rcSessions.get(id);
  if (s) s.lastActivity = Date.now();
  return s || null;
}

function sseWrite(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Connection already closed
  }
}

// Create session
app.post("/api/rc/session", (req, res) => {
  const sessionId = crypto.randomBytes(4).toString("hex");
  const authToken = crypto.randomBytes(16).toString("hex");
  rcSessions.set(sessionId, {
    playerClient: null,
    remoteClients: [],
    playbackState: null,
    lastActivity: Date.now(),
    authToken,
  });
  log("info", "RC session created", { sessionId });
  res.json({ sessionId, authToken });
});

// Session status probe (used by phone to detect expired sessions)
app.get("/api/rc/session/:sessionId", (req, res) => {
  const s = rcSessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: "session_expired" });
  s.lastActivity = Date.now();
  res.json({ exists: true, playerOnline: !!s.playerClient });
});

// Phone remote auth — validates token, sets cookie, redirects to /remote
// This endpoint is exempt from nginx basic auth.
// The cookie it sets (rc_auth) tells nginx to skip basic auth on all other requests.
app.get("/api/rc/auth", (req, res) => {
  const { token, session } = req.query;
  if (!token || !session) return res.status(400).send("Missing token or session");
  const s = rcSessions.get(session);
  if (!s || s.authToken !== token) return res.status(401).send("Invalid token");
  s.lastActivity = Date.now();
  // Set a long-lived cookie that nginx checks to skip basic auth
  res.setHeader("Set-Cookie", [
    `rc_auth=${token}; Path=/; Max-Age=${60 * 60 * 24}; SameSite=Lax`,
    `rc_token=${token}; Path=/; Max-Age=${60 * 60 * 24}; SameSite=Lax`,
  ]);
  res.redirect(`/remote?session=${session}`);
});

// Delete session
app.delete("/api/rc/session/:sessionId", (req, res) => {
  const s = rcSessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: "session not found" });
  if (s.playerClient) s.playerClient.end();
  for (const c of s.remoteClients) c.end();
  rcSessions.delete(req.params.sessionId);
  log("info", "RC session deleted", { sessionId: req.params.sessionId });
  res.json({ ok: true });
});

// SSE event stream
app.get("/api/rc/events", (req, res) => {
  const { session, role } = req.query;
  const s = rcSession(session);
  if (!s) return res.status(404).json({ error: "session not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  if (role === "player") {
    s.playerClient = res;
    // Notify remotes that player connected
    for (const c of s.remoteClients) sseWrite(c, "connected", {});
    // Send current state if any (for reconnection)
    if (s.playbackState) sseWrite(res, "state", s.playbackState);
  } else {
    s.remoteClients.push(res);
    // Send player connection status
    sseWrite(res, s.playerClient ? "connected" : "disconnected", {});
    // Send current playback state
    if (s.playbackState) sseWrite(res, "state", s.playbackState);
    // Notify player that a remote connected
    if (s.playerClient) sseWrite(s.playerClient, "remote-connected", { count: s.remoteClients.length });
  }

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    if (role === "player") {
      if (s.playerClient === res) {
        s.playerClient = null;
        for (const c of s.remoteClients) sseWrite(c, "disconnected", {});
      }
    } else {
      s.remoteClients = s.remoteClients.filter((c) => c !== res);
      // Notify player that a remote disconnected
      if (s.playerClient) sseWrite(s.playerClient, "remote-disconnected", { count: s.remoteClients.length });
    }
  });
});

// Command (phone → PC)
app.post("/api/rc/command", (req, res) => {
  const { sessionId, action, value } = req.body;
  const s = rcSession(sessionId);
  if (!s) return res.status(404).json({ error: "session not found" });
  if (s.playerClient) {
    sseWrite(s.playerClient, "command", { action, value });
  }
  res.json({ ok: true });
});

// Phone requests player to show QR for reconnection
// Broadcasts to ALL active player SSE connections (phone doesn't know which session is current)
app.post("/api/rc/request-qr", (req, res) => {
  for (const [, s] of rcSessions) {
    if (s.playerClient) sseWrite(s.playerClient, "show-qr", {});
  }
  res.json({ ok: true });
});

// State (PC → phone)
app.post("/api/rc/state", (req, res) => {
  const { sessionId, ...state } = req.body;
  const s = rcSession(sessionId);
  if (!s) return res.status(404).json({ error: "session not found" });
  s.playbackState = state;
  for (const c of s.remoteClients) sseWrite(c, "state", state);
  res.json({ ok: true });
});

// ── End Remote Control ─────────────────────────────────────────────────

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (!req.url.startsWith("/api/status") && !req.url.startsWith("/api/rc/")) {
      log("info", `${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});

// Duration endpoint - ffprobe the video to get total duration
app.get("/api/duration/:infoHash/:fileIndex", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });

  const file = torrent.files[parseInt(req.params.fileIndex, 10)];
  if (!file) return res.status(404).json({ error: "File not found" });

  const cacheKey = jobKey(torrent.infoHash, req.params.fileIndex);
  if (durationCache.has(cacheKey)) {
    return res.json({ duration: durationCache.get(cacheKey) });
  }

  const filePath = diskPath(torrent, file);
  try { statSync(filePath); } catch {
    return res.json({ duration: null });
  }

  const probe = spawn("ffprobe", [
    "-v", "quiet", "-print_format", "json",
    "-show_format",
    filePath,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let out = "";
  probe.stdout.on("data", (d) => { out += d.toString(); });
  probe.on("close", (code) => {
    if (code !== 0) return res.json({ duration: null });
    try {
      const data = JSON.parse(out);
      const dur = parseFloat(data.format?.duration);
      if (dur && isFinite(dur)) {
        durationCache.set(cacheKey, dur);
        return res.json({ duration: dur });
      }
    } catch {}
    res.json({ duration: null });
  });
});

// Subtitle endpoint - converts any subtitle format to WebVTT
app.get("/api/subtitle/:infoHash/:fileIndex", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });

  const file = torrent.files[parseInt(req.params.fileIndex, 10)];
  if (!file) return res.status(404).json({ error: "File not found" });

  const ext = path.extname(file.name).toLowerCase();
  if (!SUBTITLE_EXTENSIONS.includes(ext)) {
    return res.status(400).json({ error: "Not a subtitle file" });
  }

  const complete = isFileComplete(torrent, file);
  if (!complete) {
    return res.status(202).json({ error: "Subtitle file still downloading" });
  }

  const filePath = diskPath(torrent, file);
  const offset = parseFloat(req.query.offset) || 0;

  // For any offset or non-SRT format, use ffmpeg (handles offset via -ss)
  if (offset > 0 || (ext !== ".srt" && ext !== ".vtt")) {
    log("info", "Converting subtitle via ffmpeg", { file: file.name, ext, offset });
    const args = [
      ...(offset > 0 ? ["-ss", String(offset)] : []),
      "-i", filePath,
      "-f", "webvtt",
      "-v", "warning",
      "pipe:1",
    ];
    const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on("data", (d) => log("warn", "Subtitle ffmpeg: " + d.toString().trim()));
    ffmpeg.on("close", (code) => {
      if (code !== 0) log("err", "Subtitle conversion failed", { file: file.name, code });
    });
    res.on("close", () => ffmpeg.kill());
    return;
  }

  // VTT can be served directly (no offset)
  if (ext === ".vtt") {
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return createReadStream(filePath).pipe(res);
  }

  // SRT without offset: simple text conversion
  if (ext === ".srt") {
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const srtContent = fs.readFileSync(filePath, "utf-8");
      const vtt = srtToVtt(srtContent);
      return res.send(vtt);
    } catch (err) {
      log("err", "SRT conversion failed, falling back to ffmpeg", { error: err.message });
    }
  }

  // Fallback: ffmpeg
  const ffmpeg = spawn("ffmpeg", [
    "-i", filePath,
    "-f", "webvtt",
    "-v", "warning",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  res.setHeader("Content-Type", "text/vtt; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  ffmpeg.stdout.pipe(res);

  ffmpeg.stderr.on("data", (d) => log("warn", "Subtitle ffmpeg: " + d.toString().trim()));
  ffmpeg.on("close", (code) => {
    if (code !== 0) log("err", "Subtitle conversion failed", { file: file.name, code });
  });
  res.on("close", () => ffmpeg.kill());
});


// Probe embedded subtitle streams in a video file
app.get("/api/subtitles/:infoHash/:fileIndex", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });

  const file = torrent.files[parseInt(req.params.fileIndex, 10)];
  if (!file) return res.status(404).json({ error: "File not found" });

  // Try to probe even if not complete - ffprobe can read partial files
  const complete = isFileComplete(torrent, file);
  const filePath = diskPath(torrent, file);

  // Check file exists on disk at all
  try { statSync(filePath); } catch {
    return res.json({ tracks: [], complete: false });
  }

  // Use ffprobe to list subtitle streams
  const probe = spawn("ffprobe", [
    "-v", "quiet", "-print_format", "json",
    "-show_streams", "-select_streams", "s",
    filePath,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let out = "";
  probe.stdout.on("data", (d) => { out += d.toString(); });
  probe.on("close", (code) => {
    if (code !== 0) return res.json({ tracks: [], complete });
    try {
      const data = JSON.parse(out);
      const tracks = (data.streams || []).map((s, idx) => ({
        streamIndex: s.index,
        lang: s.tags?.language || null,
        title: s.tags?.title || null,
        codec: s.codec_name,
      }));
      log("info", "Subtitle probe", { file: file.name, tracks: tracks.length, complete });
      res.json({ tracks, complete });
    } catch {
      res.json({ tracks: [], complete });
    }
  });
});

// List embedded audio streams
app.get("/api/audio-tracks/:infoHash/:fileIndex", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });

  const file = torrent.files[parseInt(req.params.fileIndex, 10)];
  if (!file) return res.status(404).json({ error: "File not found" });

  const complete = isFileComplete(torrent, file);
  const filePath = diskPath(torrent, file);

  try { statSync(filePath); } catch {
    return res.json({ tracks: [], complete: false });
  }

  const probe = spawn("ffprobe", [
    "-v", "quiet", "-print_format", "json",
    "-show_streams", "-select_streams", "a",
    filePath,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let out = "";
  probe.stdout.on("data", (d) => { out += d.toString(); });
  probe.on("close", (code) => {
    if (code !== 0) return res.json({ tracks: [], complete });
    try {
      const data = JSON.parse(out);
      const tracks = (data.streams || []).map((s) => ({
        streamIndex: s.index,
        lang: s.tags?.language || null,
        title: s.tags?.title || null,
        codec: s.codec_name,
        channels: s.channels || 0,
      }));
      log("info", "Audio track probe", { file: file.name, tracks: tracks.length, complete });
      res.json({ tracks, complete });
    } catch {
      res.json({ tracks: [], complete });
    }
  });
});

// Intro detection — returns skip timestamps for TV episode intros
app.get("/api/intro/:infoHash/:fileIndex", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const tmdbId = req.query.tmdbId;
  const season = parseInt(req.query.season, 10);
  const episode = parseInt(req.query.episode, 10);
  const title = req.query.title || "";

  // Check cache first (works even if torrent is gone)
  if (tmdbId && season) {
    const cacheKey = `${tmdbId}:${season}`;
    const cached = introCache.get(cacheKey);
    if (cached && cached.source === "fingerprint") {
      return res.json({ detected: true, ...cached });
    }
  }

  // Collect sibling video files for fingerprinting
  const siblingPaths = [];
  let currentPath = null;
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);

  if (torrent) {
    // Torrent is active — scan its file list
    // Only include files where the first ~5 min of data is actually downloaded
    // (WebTorrent pre-allocates full file size, so stat check is unreliable)
    const fileIdx = parseInt(req.params.fileIndex, 10);
    const file = torrent.files[fileIdx];
    if (file) currentPath = diskPath(torrent, file);
    const pieceLength = torrent.pieceLength || 262144;
    for (const f of torrent.files) {
      const ext = path.extname(f.name).toLowerCase();
      if (!VIDEO_EXTENSIONS.includes(ext)) continue;
      // Check if the first ~10% of the file has been downloaded (enough for 5 min audio)
      // by verifying the first N pieces are available
      const fileOffset = getFileOffset(f);
      const firstPiece = Math.floor(fileOffset / pieceLength);
      const bytesNeeded = Math.min(f.length * 0.1, 200_000_000); // 10% or 200MB, whichever is less
      const piecesNeeded = Math.ceil(bytesNeeded / pieceLength);
      let hasBeginning = true;
      for (let p = firstPiece; p < firstPiece + piecesNeeded; p++) {
        if (!hasPiece(torrent, p)) { hasBeginning = false; break; }
      }
      if (hasBeginning) {
        const fp = diskPath(torrent, f);
        siblingPaths.push(fp);
      }
    }
  }

  // Also scan the download directory for video files from any torrent
  // This finds episodes that persist on disk after torrent idle-timeout
  // Validate with a quick ffprobe since these may be incomplete downloads
  try {
    for (const dir of fs.readdirSync(DOWNLOAD_PATH)) {
      const dirPath = path.join(DOWNLOAD_PATH, dir);
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
        for (const fname of fs.readdirSync(dirPath)) {
          const ext = path.extname(fname).toLowerCase();
          if (!VIDEO_EXTENSIONS.includes(ext)) continue;
          const fp = path.join(dirPath, fname);
          if (siblingPaths.includes(fp)) continue;
          try {
            if (statSync(fp).size > 50_000_000) siblingPaths.push(fp);
          } catch {}
        }
      } catch {}
    }
  } catch {}

  // If we don't have a currentPath from the torrent, try to find the streaming file
  // from the /api/stream endpoint's perspective (it may have been served from disk)
  if (!currentPath && siblingPaths.length > 0) {
    // Use the first file as a fallback — fingerprinting just needs any 2 episodes
    currentPath = siblingPaths[0];
  }

  // Try fingerprint detection if we have 2+ files
  if (siblingPaths.length >= 2) {
    // Pass all siblings (not just 2) so detectIntro can skip corrupt files
    const ordered = currentPath
      ? [currentPath, ...siblingPaths.filter((p) => p !== currentPath)]
      : [...siblingPaths];
    try {
      const result = await detectIntro(ordered);
      if (result) {
        const entry = { intro_start: result.intro_start, intro_end: result.intro_end, source: "fingerprint" };
        if (tmdbId && season) introCache.set(`${tmdbId}:${season}`, entry);
        return res.json({ detected: true, ...entry });
      }
    } catch (err) {
      log("warn", "Intro fingerprint detection failed", { error: err.message });
    }
  }

  // Fallback: AniSkip external lookup
  if (title && episode) {
    const cacheKey = torrent ? jobKey(torrent.infoHash, req.params.fileIndex) : null;
    const dur = cacheKey ? (durationCache.get(cacheKey) || 0) : 0;
    try {
      const result = await lookupExternal(title, season || 1, episode, dur);
      if (result) {
        const entry = { intro_start: result.intro_start, intro_end: result.intro_end, source: "external" };
        if (tmdbId && season) introCache.set(`${tmdbId}:${season}`, entry);
        return res.json({ detected: true, ...entry });
      }
    } catch (err) {
      log("warn", "AniSkip lookup failed", { error: err.message });
    }
  }

  res.json({ detected: false });
});

// Extract an embedded subtitle stream as WebVTT
app.get("/api/subtitle-extract/:infoHash/:fileIndex/:streamIndex", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });

  const file = torrent.files[parseInt(req.params.fileIndex, 10)];
  if (!file) return res.status(404).json({ error: "File not found" });

  const filePath = diskPath(torrent, file);
  const streamIdx = parseInt(req.params.streamIndex, 10);

  // Check file exists on disk
  try { statSync(filePath); } catch {
    return res.status(202).json({ error: "File not on disk yet" });
  }

  const offset = parseFloat(req.query.offset) || 0;
  log("info", "Extracting embedded subtitle", { file: file.name, stream: streamIdx, offset });

  const args = [
    ...(offset > 0 ? ["-ss", String(offset)] : []),
    "-i", filePath,
    "-map", `0:${streamIdx}`,
    "-f", "webvtt",
    "-v", "warning",
    "pipe:1",
  ];
  const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  res.setHeader("Content-Type", "text/vtt; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on("data", (d) => log("warn", "Sub extract: " + d.toString().trim()));
  ffmpeg.on("close", (code) => {
    if (code !== 0) log("err", "Sub extract failed", { stream: streamIdx, code });
  });
  res.on("close", () => ffmpeg.kill());
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


// ---- TMDB API Proxy (with cache) ----

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
