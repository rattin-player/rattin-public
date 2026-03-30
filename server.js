import express from "express";
import WebTorrent from "webtorrent";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createReadStream, statSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { tmdbCache, CACHE_TTL, fetchTMDB, startCacheJanitor } from "./lib/cache.js";
import { buildSeekIndex, findSeekOffset, waitForPieces } from "./lib/seek-index.js";
import { jobKey, registerCache, cleanupHash, pruneOrphans, cacheStats } from "./lib/torrent-caches.js";
import { getFileOffset, getFileEndPiece, hasPiece } from "./lib/torrent-compat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const client = new WebTorrent();

const DOWNLOAD_PATH = "/tmp/rattin";
const TRANSCODE_PATH = "/tmp/rattin-transcoded";
const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".ts", ".flv", ".wmv"];
const AUDIO_EXTENSIONS = [".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".wav", ".wma"];
const SUBTITLE_EXTENSIONS = [".srt", ".ass", ".ssa", ".vtt", ".sub"];
const ALLOWED_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...SUBTITLE_EXTENSIONS]);
const BROWSER_NATIVE = new Set([".mp4", ".m4v", ".webm"]);

const transcodeJobs = new Map();
const durationCache = new Map(); // "infoHash:fileIndex" -> seconds
const seekIndexCache = new Map(); // "infoHash:fileIndex" -> [{ time, offset }, ...]
const seekIndexPending = new Set(); // jobKeys currently being indexed (prevents duplicate attempts)
const activeFiles = new Map(); // "infoHash" -> Set of fileIndex
const streamTracker = new Map(); // infoHash -> { count, idleTimer }

registerCache("transcodeJobs", transcodeJobs, "hash:index");
registerCache("durationCache", durationCache, "hash:index");
registerCache("seekIndexCache", seekIndexCache, "hash:index");
registerCache("seekIndexPending", seekIndexPending, "hash:index");
registerCache("activeFiles", activeFiles, "hash");

function log(level, msg, data) {
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = { info: "INFO", warn: "WARN", err: " ERR" }[level] || level;
  const extra = data ? " " + JSON.stringify(data) : "";
  console.log(`[${ts}] ${prefix}  ${msg}${extra}`);
}

function diskPath(torrent, file) {
  return path.join(DOWNLOAD_PATH, file.path);
}

function isFileComplete(torrent, file) {
  if (file.length > 0 && file.downloaded < file.length) return false;
  try {
    const stat = statSync(diskPath(torrent, file));
    return stat.size === file.length;
  } catch {
    return false;
  }
}

function needsTranscode(ext) {
  return !BROWSER_NATIVE.has(ext);
}

function isAllowedFile(name) {
  const ext = path.extname(name).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

// Clean all caches for a torrent — delegates to central registry
function cleanupTorrentCaches(infoHash, torrent) {
  const filePaths = torrent?.files
    ? torrent.files.map((f) => diskPath(torrent, f))
    : [];
  cleanupHash(infoHash, filePaths);
}

function trackStreamOpen(infoHash) {
  const entry = streamTracker.get(infoHash) || { count: 0, idleTimer: null };
  entry.count++;
  if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
  streamTracker.set(infoHash, entry);
}

function trackStreamClose(infoHash) {
  const entry = streamTracker.get(infoHash);
  if (!entry) return;
  entry.count = Math.max(0, entry.count - 1);
  if (entry.count > 0) return;
  // All streams closed — kill background transcodes and free torrent after 2 min
  entry.idleTimer = setTimeout(() => {
    for (const [key, job] of transcodeJobs) {
      if (key.startsWith(infoHash.toLowerCase() + ":")) {
        if (job.process && !job.done) {
          job.process.kill();
          log("info", "Killed idle transcode", { jobKey: key });
        }
        transcodeJobs.delete(key);
      }
    }
    const torrent = client.torrents.find((t) => t.infoHash === infoHash);
    if (torrent) {
      cleanupTorrentCaches(infoHash, torrent);
      log("info", "Auto-removing idle torrent", { name: torrent.name });
      torrent.destroy({ destroyStore: false });
    }
    streamTracker.delete(infoHash);
  }, 2 * 60 * 1000);
}

// Middleware that auto-tracks stream open/close for any /api/stream* route.
// INVARIANT: Every endpoint that serves torrent data MUST go through this
// middleware, or the idle timer will destroy the torrent prematurely.
function streamTracking(req, res, next) {
  const infoHash = req.params.infoHash;
  if (!infoHash) return next();
  trackStreamOpen(infoHash);
  res.on("close", () => trackStreamClose(infoHash));
  next();
}

// Verify a file is actually media by probing its content with ffprobe.
// Returns { valid, format, streams } or { valid: false, reason }.
const probeCache = new Map(); // filePath -> result
registerCache("probeCache", probeCache, "path");
function probeMedia(filePath) {
  if (probeCache.has(filePath)) return Promise.resolve(probeCache.get(filePath));
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet", "-print_format", "json",
      "-show_format", "-show_streams",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        return resolve({ valid: false, reason: "ffprobe failed — not a valid media file" });
      }
      try {
        const data = JSON.parse(out);
        const fmt = data.format?.format_name || "";
        const streams = data.streams || [];
        const hasMedia = streams.some((s) =>
          s.codec_type === "video" || s.codec_type === "audio"
        );
        if (!hasMedia) {
          return resolve({ valid: false, reason: "No video or audio streams detected" });
        }
        const dur = parseFloat(data.format?.duration);
        const videoStream = streams.find((s) => s.codec_type === "video");
        const audioStream = streams.find((s) => s.codec_type === "audio");
        const result = {
          valid: true, format: fmt, streams: streams.length,
          duration: dur && isFinite(dur) ? dur : 0,
          videoCodec: videoStream?.codec_name || "",
          audioCodec: audioStream?.codec_name || "",
        };
        probeCache.set(filePath, result);
        log("info", "Media probe OK", { file: path.basename(filePath), format: fmt, streams: streams.length, duration: result.duration, vcodec: result.videoCodec });
        resolve(result);
      } catch {
        resolve({ valid: false, reason: "Failed to parse probe output" });
      }
    });
    proc.on("error", () => {
      resolve({ valid: false, reason: "ffprobe not available" });
    });
  });
}

// Start background transcode to a proper MP4 with faststart (moov at beginning).
// This is what makes seeking work - the browser can read the moov atom first
// and know the full duration + seek table.
function startTranscode(inputPath, cacheKey, audioStreamIdx = null) {
  fs.mkdirSync(TRANSCODE_PATH, { recursive: true });
  const outputPath = path.join(TRANSCODE_PATH, cacheKey.replace(/:/g, "_") + ".mp4");

  if (transcodeJobs.has(cacheKey)) {
    const job = transcodeJobs.get(cacheKey);
    if ((job.done && !job.error) || (!job.done && !job.error)) return job;
  }

  // Check probe cache to decide whether remux is likely to work
  const cached = probeCache.get(inputPath);
  const canRemux = !cached?.videoCodec || cached.videoCodec === "h264";

  log("info", "Starting transcode", { input: path.basename(inputPath), canRemux, vcodec: cached?.videoCodec });
  const job = { outputPath, done: false, error: null, process: null };
  transcodeJobs.set(cacheKey, job);

  function startEncode() {
    const proc2 = spawn("ffmpeg", [
      "-i", inputPath,
      ...(audioStreamIdx !== null ? ["-map", "0:v:0", "-map", `0:${audioStreamIdx}`] : []),
      "-c:v", "libx264", "-preset", "fast", "-crf", "22",
      "-c:a", "aac",
      "-movflags", "+faststart",
      "-y", outputPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    job.process = proc2;

    let encodeStderr = "";
    proc2.stderr.on("data", (d) => {
      const chunk = d.toString();
      encodeStderr = (encodeStderr + chunk).slice(-1024);
      const m = chunk.match(/time=(\S+)/);
      if (m) log("info", "Transcode progress", { time: m[1] });
    });

    proc2.on("close", (code2) => {
      if (code2 === 0) {
        job.done = true;
        log("info", "Transcode complete (re-encode)");
      } else {
        job.error = "Transcode failed (code " + code2 + ")";
        log("err", "Transcode re-encode failed", { code: code2, stderr: encodeStderr.slice(-300) });
      }
    });
    proc2.on("error", (err) => {
      job.error = "ffmpeg error: " + err.message;
    });
  }

  // Skip remux if video codec isn't H.264 — go straight to re-encode
  if (!canRemux) {
    startEncode();
    return job;
  }

  // Try remux first (fast - just repackage, no re-encoding)
  const proc = spawn("ffmpeg", [
    "-i", inputPath,
    ...(audioStreamIdx !== null ? ["-map", "0:v:0", "-map", `0:${audioStreamIdx}`] : []),
    "-c:v", "copy", "-c:a", "aac",
    "-movflags", "+faststart",
    "-y", outputPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  job.process = proc;

  let remuxStderr = "";
  proc.stderr.on("data", (d) => { remuxStderr = (remuxStderr + d.toString()).slice(-1024); });

  proc.on("close", (code) => {
    if (code === 0) {
      job.done = true;
      log("info", "Transcode complete (remux)", { output: path.basename(outputPath) });
    } else {
      log("info", "Remux failed (code " + code + "), re-encoding with H.264", { stderr: remuxStderr.slice(-200) });
      startEncode();
    }
  });

  proc.on("error", (err) => {
    job.error = "ffmpeg error: " + err.message;
    log("err", "ffmpeg spawn error", { error: err.message });
  });

  return job;
}

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

// ── Auth persistence ───────────────────────────────────────────────────
// Stable token generated once per server start. After the PC passes nginx
// basic auth once, the app sets a 30-day cookie with this token. Nginx's
// auth_request accepts the cookie on subsequent requests, skipping the
// basic auth prompt.
const pcAuthToken = crypto.randomBytes(16).toString("hex");

app.get("/api/auth/persist", (req, res) => {
  // Only reachable after nginx basic auth succeeded (or a valid token).
  // Set a long-lived cookie — nginx skips basic auth when rc_auth cookie exists.
  res.setHeader("Set-Cookie",
    `rc_auth=${pcAuthToken}; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`);
  res.json({ ok: true });
});

// ── Remote Control (SSE + REST relay) ──────────────────────────────────
const rcSessions = new Map(); // sessionId -> { playerClient, remoteClients, playbackState, lastActivity }

function rcSession(id) {
  const s = rcSessions.get(id);
  if (s) s.lastActivity = Date.now();
  return s || null;
}

// Expire sessions after 24h of inactivity
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, s] of rcSessions) {
    if (s.lastActivity < cutoff) {
      if (s.playerClient) s.playerClient.end();
      for (const c of s.remoteClients) c.end();
      rcSessions.delete(id);
      log("info", "RC session expired", { sessionId: id });
    }
  }
}, 60 * 1000);

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

// Simple SRT to VTT converter
function srtToVtt(srt) {
  let vtt = "WEBVTT\n\n";
  // Normalize line endings and split into blocks
  const blocks = srt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n");
    // Find the timestamp line (contains " --> ")
    const tsIdx = lines.findIndex((l) => l.includes(" --> "));
    if (tsIdx === -1) continue;
    // Convert commas to dots in timestamps (SRT uses commas, VTT uses dots)
    const timestamp = lines[tsIdx].replace(/,/g, ".");
    const text = lines.slice(tsIdx + 1).join("\n");
    if (text.trim()) {
      vtt += timestamp + "\n" + text + "\n\n";
    }
  }
  return vtt;
}

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
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });

  const file = torrent.files[parseInt(req.params.fileIndex, 10)];
  if (!file) return res.status(404).json({ error: "File not found" });

  if (!isAllowedFile(file.name)) {
    return res.status(403).json({ error: "File type not allowed" });
  }

  const ext = path.extname(file.name).toLowerCase();
  const fileIdx = parseInt(req.params.fileIndex, 10);
  const audioStreamIdx = req.query.audio ? parseInt(req.query.audio, 10) : null;

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
    return serveLiveTranscode(torrent, file, true, req, res, parseFloat(req.query.t) || 0, audioStreamIdx);
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
          return serveLiveTranscode(torrent, file, true, req, res, seekTo, audioStreamIdx);
        }

        // Pieces not ready — fetch them, then use fast path
        log("info", "Smart seek (fetching)", { seekTo, byteStart });
        const doSmartSeek = async () => {
          try {
            await waitForPieces(torrent, file, byteStart, byteEnd, 30000);
            torrent.select(firstPiece, getFileEndPiece(file), 1);
            return serveLiveTranscode(torrent, file, true, req, res, seekTo, audioStreamIdx);
          } catch {
            log("warn", "Smart seek timeout, falling back", { seekTo });
            return serveLiveTranscode(torrent, file, complete, req, res, seekTo, audioStreamIdx);
          }
        };
        return doSmartSeek();
      }
    }

    log("info", "Live transcode", { file: file.name, complete, seekTo });
    return serveLiveTranscode(torrent, file, complete, req, res, seekTo, audioStreamIdx);
  }

  // 4) Native format, still downloading - WebTorrent stream
  log("info", "Streaming via WebTorrent", { file: file.name });
  serveFromTorrent(file, req, res);
});

// Serve a complete file from disk with proper range support
function serveFile(filePath, fileSize, contentType, req, res) {
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType,
      "X-Accel-Buffering": "no",
    });
    const s = createReadStream(filePath, { start, end });
    s.on("error", () => s.destroy());
    res.on("close", () => s.destroy());
    s.pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "X-Accel-Buffering": "no",
    });
    const s = createReadStream(filePath);
    s.on("error", () => s.destroy());
    res.on("close", () => s.destroy());
    s.pipe(res);
  }
}

// Stream from WebTorrent (still downloading, native format)
function serveFromTorrent(file, req, res) {
  const range = req.headers.range;
  const size = file.length;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": "video/mp4",
      "X-Accel-Buffering": "no",
    });
    const s = file.createReadStream({ start, end });
    s.on("error", () => s.destroy());
    res.on("close", () => s.destroy());
    s.pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": size,
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "X-Accel-Buffering": "no",
    });
    const s = file.createReadStream();
    s.on("error", () => s.destroy());
    res.on("close", () => s.destroy());
    s.pipe(res);
  }
}

// Live transcode through ffmpeg (for MKV etc, before background transcode is ready)
function serveLiveTranscode(torrent, file, complete, req, res, seekTo = 0, audioStreamIdx = null) {
  const filePath = diskPath(torrent, file);
  // Only use disk file when download is complete — partial files have gaps that break ffmpeg
  const useStdin = !complete;
  const input = useStdin ? "pipe:0" : filePath;

  const doSeek = seekTo > 0;

  // Never use copy mode — it causes random freezes and A/V desync due to
  // B-frame DTS going backward across fragmented MP4 fragment boundaries.
  const cached = probeCache.get(filePath);
  const browserSafeCodec = !cached?.videoCodec || cached.videoCodec === "h264";
  const needsDownscale = !browserSafeCodec && cached?.videoCodec;

  const vFilters = [];
  if (needsDownscale) vFilters.push("scale=-2:1080");
  if (!browserSafeCodec) vFilters.push("format=yuv420p");

  const args = [
    ...(useStdin ? ["-analyzeduration", "5000000", "-probesize", "5000000"] : []),
    ...(doSeek && !useStdin ? ["-ss", String(seekTo)] : []),
    "-i", input,
    ...(doSeek && useStdin ? ["-ss", String(seekTo)] : []),
    "-map", "0:v:0", "-map", audioStreamIdx !== null ? `0:${audioStreamIdx}` : "0:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
    ...(vFilters.length > 0 ? ["-vf", vFilters.join(",")] : []),
    "-c:a", "aac", "-ac", "2",
    "-max_muxing_queue_size", "1024",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "-v", "warning",
    "pipe:1",
  ];

  log("info", "Live transcode", { input: useStdin ? "pipe" : "disk", seekTo, doSeek });

  const ffmpeg = spawn("ffmpeg", args, {
    stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
  });

  let torrentStream = null;
  if (useStdin) {
    torrentStream = file.createReadStream();
    torrentStream.on("error", () => { torrentStream.destroy(); ffmpeg.kill(); });
    torrentStream.pipe(ffmpeg.stdin);
    ffmpeg.stdin.on("error", () => {});
  }

  ffmpeg.stderr.on("data", () => {});

  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Transfer-Encoding": "chunked",
    "X-Accel-Buffering": "no",
    "Cache-Control": "no-cache",
  });

  ffmpeg.stdout.pipe(res);

  // Watchdog: kill ffmpeg if no output for 30s (nginx may not detect client disconnect when stalled)
  let lastOutput = Date.now();
  ffmpeg.stdout.on("data", () => { lastOutput = Date.now(); });
  const watchdog = setInterval(() => {
    if (Date.now() - lastOutput > 30000) {
      clearInterval(watchdog);
      log("info", "Watchdog: killing stale ffmpeg (no output for 30s)");
      if (torrentStream) torrentStream.destroy();
      ffmpeg.kill("SIGKILL");
    }
  }, 10000);

  ffmpeg.on("close", (code) => {
    clearInterval(watchdog);
    if (code && code !== 0 && code !== 255 && !res.destroyed) {
      log("warn", "First attempt failed, retrying with full re-encode");
      const retryFilters = [];
      if (needsDownscale) retryFilters.push("scale=-2:1080");
      retryFilters.push("format=yuv420p");
      const args2 = [
        ...(useStdin ? ["-analyzeduration", "5000000", "-probesize", "5000000"] : []),
        ...(doSeek && !useStdin ? ["-ss", String(seekTo)] : []),
        "-i", input,
        ...(doSeek && useStdin ? ["-ss", String(seekTo)] : []),
        "-map", "0:v:0", "-map", audioStreamIdx !== null ? `0:${audioStreamIdx}` : "0:a:0",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-vf", retryFilters.join(","),
        "-c:a", "aac", "-ac", "2",
        "-max_muxing_queue_size", "1024",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "-v", "warning",
        "pipe:1",
      ];
      const ff2 = spawn("ffmpeg", args2, { stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"] });
      let lastOutput2 = Date.now();
      const watchdog2 = setInterval(() => {
        if (Date.now() - lastOutput2 > 30000) {
          clearInterval(watchdog2);
          log("info", "Watchdog: killing stale retry ffmpeg");
          ff2.kill("SIGKILL");
        }
      }, 10000);
      ff2.stdout.on("data", () => { lastOutput2 = Date.now(); });
      ff2.on("close", () => { clearInterval(watchdog2); });
      if (useStdin) {
        const ts2 = file.createReadStream();
        ts2.on("error", () => { ts2.destroy(); ff2.kill(); });
        ts2.pipe(ff2.stdin);
        ff2.stdin.on("error", () => {});
        res.on("close", () => { clearInterval(watchdog2); ts2.destroy(); ff2.kill(); });
      }
      ff2.stderr.on("data", () => {});
      ff2.stdout.pipe(res, { end: true });
      if (!useStdin) res.on("close", () => { clearInterval(watchdog2); ff2.kill(); });
    }
  });

  res.on("close", () => {
    clearInterval(watchdog);
    if (torrentStream) torrentStream.destroy();
    ffmpeg.kill();
  });
}

// Status
app.get("/api/status/:infoHash", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });

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

function fmtBytes(b) {
  if (b === 0) return "0 B";
  const k = 1024, s = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + " " + s[i];
}

function throttle(fn, ms) {
  let last = 0;
  return (...a) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...a); } };
}

// ---- TMDB API Proxy (with cache) ----

startCacheJanitor(log);

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

function scoreTorrent(result, title, year, type) {
  let score = 0;
  const name = result.name.toLowerCase();
  const titleLower = title.toLowerCase();

  if (!name.includes(titleLower.split(" ")[0])) return -1;

  const titleWords = titleLower.split(/\s+/);
  const matchedWords = titleWords.filter((w) => name.includes(w)).length;
  score += (matchedWords / titleWords.length) * 50;

  if (year && name.includes(String(year))) score += 15;

  if (/1080p/.test(name)) score += 20;
  if (/2160p|4k/i.test(name)) score += 15;
  if (/720p/.test(name)) score += 10;
  if (/blu-?ray|bdrip|bdremux/i.test(name)) score += 15;
  if (/web-?dl|webrip/i.test(name)) score += 12;
  if (/remux/i.test(name)) score += 10;

  if (/\bcam\b|hdcam|telecine|\bts\b|hdts|telesync/i.test(name)) score -= 50;

  // Prefer MP4 (browser-native, no transcode needed)
  if (/\.mp4\b/i.test(name)) score += 15;
  if (/\bx264\b.*\.mp4|\.mp4\b.*\bx264\b/i.test(name)) score += 5;
  // Penalize MKV slightly (needs transcode)
  if (/\.mkv\b/i.test(name)) score -= 5;

  if (result.seeders === 0) return -1;
  score += Math.min(30, Math.log2(result.seeders + 1) * 3);

  return score;
}

// ---- Availability Check ----

const availabilityCache = new Map(); // "title:year" -> { available: bool, ts: number }
const AVAIL_TTL = 2 * 60 * 60 * 1000; // 2 hours

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

function parseTags(name) {
  const tags = [];
  const n = name;
  // Resolution
  if (/2160p/i.test(n)) tags.push("4K");
  else if (/1080p/i.test(n)) tags.push("1080p");
  else if (/720p/i.test(n)) tags.push("720p");
  else if (/480p/i.test(n)) tags.push("480p");
  // Source
  if (/blu-?ray|bdremux/i.test(n)) tags.push("BluRay");
  else if (/web-?dl/i.test(n)) tags.push("WEB-DL");
  else if (/webrip/i.test(n)) tags.push("WEBRip");
  else if (/bdrip/i.test(n)) tags.push("BDRip");
  else if (/hdtv/i.test(n)) tags.push("HDTV");
  else if (/\bcam\b|hdcam/i.test(n)) tags.push("CAM");
  // Codec
  if (/\bx265\b|\bhevc\b/i.test(n)) tags.push("HEVC");
  else if (/\bx264\b|\bavc\b/i.test(n)) tags.push("x264");
  else if (/\bav1\b/i.test(n)) tags.push("AV1");
  // Audio
  if (/atmos/i.test(n)) tags.push("Atmos");
  else if (/\bdts\b/i.test(n)) tags.push("DTS");
  else if (/ddp?\s?5\.1|dd\+?\s?5\.1|eac3/i.test(n)) tags.push("5.1");
  // Container
  if (/\.mp4\b/i.test(n)) tags.push("MP4");
  else if (/\.mkv\b/i.test(n)) tags.push("MKV");
  // Extras
  if (/remux/i.test(n)) tags.push("Remux");
  if (/hdr10\+/i.test(n)) tags.push("HDR10+");
  else if (/hdr/i.test(n)) tags.push("HDR");
  return tags;
}

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
  let best = null;
  if (!torrent.files) return null;
  torrent.files.forEach((f, i) => {
    const ext = path.extname(f.name).toLowerCase();
    if (VIDEO_EXTENSIONS.includes(ext)) {
      if (!best || f.length > best.file.length) best = { file: f, index: i };
    }
  });
  return best;
}

function findEpisodeFile(torrent, season, episode) {
  if (!torrent.files || !season || !episode) return findLargestVideo(torrent);
  const s = String(season).padStart(2, "0");
  const e = String(episode).padStart(2, "0");
  const sNum = String(season);
  const eNum = String(episode);
  // Match patterns: S01E05, S1E5, 1x05, E05, Episode 5, Episode.05, Ep05
  const patterns = [
    new RegExp(`S${s}E${e}(?!\\d)`, "i"),           // S01E05
    new RegExp(`S${sNum}E${eNum}(?!\\d)`, "i"),      // S1E5
    new RegExp(`${sNum}x${e}(?!\\d)`, "i"),           // 1x05
    new RegExp(`${sNum}x${eNum}(?!\\d)`, "i"),        // 1x5
    new RegExp(`[._\\s/-]E${e}(?!\\d)`, "i"),         // .E05 _E05
    new RegExp(`[._\\s/-]E${eNum}(?!\\d)`, "i"),      // .E5
    new RegExp(`Episode[._\\s-]?${e}(?!\\d)`, "i"),   // Episode.05, Episode 05
    new RegExp(`Episode[._\\s-]?${eNum}(?!\\d)`, "i"),// Episode.5, Episode 5
    new RegExp(`Ep[._\\s-]?${e}(?!\\d)`, "i"),        // Ep05, Ep.05
  ];
  let best = null;
  torrent.files.forEach((f, i) => {
    const ext = path.extname(f.name).toLowerCase();
    if (!VIDEO_EXTENSIONS.includes(ext)) return;
    // Use just the filename, not the full path with folders
    const name = f.name.split("/").pop();
    for (const pat of patterns) {
      if (pat.test(name)) {
        if (!best || f.length > best.file.length) best = { file: f, index: i };
        return;
      }
    }
  });
  // If no episode match found, fall back to largest (single-episode torrent)
  return best || findLargestVideo(torrent);
}

// Cache janitor — every 5 min, prune entries for removed torrents
setInterval(() => {
  const activeHashes = new Set(client.torrents.map((t) => t.infoHash));
  let pruned = pruneOrphans(activeHashes, statSync);
  // Availability cache has its own TTL — prune separately
  const now = Date.now();
  for (const [key, entry] of availabilityCache) {
    if (now - entry.ts > AVAIL_TTL) { availabilityCache.delete(key); pruned++; }
  }
  if (pruned > 0) log("info", "Cache janitor", { pruned, ...cacheStats(), availability: availabilityCache.size });
}, 5 * 60 * 1000);

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function cleanup() {
  log("info", "Shutting down...");
  for (const [, job] of transcodeJobs) if (job.process && !job.done) job.process.kill();
  client.destroy(() => {
    log("info", "Stopped");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log("info", `Rattin running at http://localhost:${PORT}`);
});
