import express from "express";
import WebTorrent from "webtorrent";
import path from "path";
import fs from "fs";
import { createReadStream, statSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

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
const activeFiles = new Map(); // "infoHash" -> Set of fileIndex

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

// Verify a file is actually media by probing its content with ffprobe.
// Returns { valid, format, streams } or { valid: false, reason }.
const probeCache = new Map(); // filePath -> result
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
        const result = { valid: false, reason: "ffprobe failed — not a valid media file" };
        probeCache.set(filePath, result);
        return resolve(result);
      }
      try {
        const data = JSON.parse(out);
        const fmt = data.format?.format_name || "";
        const streams = data.streams || [];
        const hasMedia = streams.some((s) =>
          s.codec_type === "video" || s.codec_type === "audio"
        );
        if (!hasMedia) {
          const result = { valid: false, reason: "No video or audio streams detected" };
          probeCache.set(filePath, result);
          return resolve(result);
        }
        const result = { valid: true, format: fmt, streams: streams.length };
        probeCache.set(filePath, result);
        log("info", "Media probe OK", { file: path.basename(filePath), format: fmt, streams: streams.length });
        resolve(result);
      } catch {
        const result = { valid: false, reason: "Failed to parse probe output" };
        probeCache.set(filePath, result);
        resolve(result);
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
function startTranscode(inputPath, jobKey) {
  fs.mkdirSync(TRANSCODE_PATH, { recursive: true });
  const outputPath = path.join(TRANSCODE_PATH, jobKey.replace(/:/g, "_") + ".mp4");

  if (transcodeJobs.has(jobKey)) {
    const job = transcodeJobs.get(jobKey);
    if ((job.done && !job.error) || (!job.done && !job.error)) return job;
  }

  log("info", "Starting transcode", { input: path.basename(inputPath) });
  const job = { outputPath, done: false, error: null, process: null };
  transcodeJobs.set(jobKey, job);

  // Try remux first (fast - just repackage, no re-encoding)
  const proc = spawn("ffmpeg", [
    "-i", inputPath,
    "-c:v", "copy", "-c:a", "aac",
    "-movflags", "+faststart",
    "-y", outputPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  job.process = proc;

  let remuxStderr = "";
  proc.stderr.on("data", (d) => { remuxStderr += d.toString(); });

  proc.on("close", (code) => {
    if (code === 0) {
      job.done = true;
      log("info", "Transcode complete (remux)", { output: path.basename(outputPath) });
    } else {
      log("info", "Remux failed (code " + code + "), re-encoding with H.264", {
        stderr: remuxStderr.slice(-200)
      });
      const proc2 = spawn("ffmpeg", [
        "-i", inputPath,
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-c:a", "aac",
        "-movflags", "+faststart",
        "-y", outputPath,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      job.process = proc2;

      let encodeStderr = "";
      proc2.stderr.on("data", (d) => {
        encodeStderr += d.toString();
        const m = d.toString().match(/time=(\S+)/);
        if (m) log("info", "Transcode progress", { time: m[1] });
      });

      proc2.on("close", (code2) => {
        if (code2 === 0) {
          job.done = true;
          log("info", "Transcode complete (re-encode)");
        } else {
          job.error = "Transcode failed (code " + code2 + ")";
          log("err", "Transcode re-encode failed", {
            code: code2, stderr: encodeStderr.slice(-300)
          });
        }
      });

      proc2.on("error", (err) => {
        job.error = "ffmpeg error: " + err.message;
        log("err", "ffmpeg spawn error", { error: err.message });
      });
    }
  });

  proc.on("error", (err) => {
    job.error = "ffmpeg error: " + err.message;
    log("err", "ffmpeg spawn error", { error: err.message });
  });

  return job;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Torrent search proxy (avoids CORS, queries apibay)
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);

  try {
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(q)}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "MagnetPlayer/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error("Search API returned " + resp.status);
    const data = await resp.json();
    // apibay returns [{id, name, info_hash, leechers, seeders, num_files, size, ...}]
    // Filter out the "no results" placeholder (id "0" with name "No results...")
    const results = (Array.isArray(data) ? data : [])
      .filter((r) => r.id !== "0" && r.name !== "No results returned")
      .map((r) => ({
        name: r.name,
        infoHash: r.info_hash,
        size: parseInt(r.size, 10) || 0,
        seeders: parseInt(r.seeders, 10) || 0,
        leechers: parseInt(r.leechers, 10) || 0,
        numFiles: parseInt(r.num_files, 10) || 0,
        added: r.added,
        category: r.category,
      }));
    log("info", "Search", { query: q, results: results.length });
    res.json(results);
  } catch (err) {
    log("err", "Search failed", { error: err.message });
    res.status(502).json({ error: "Search failed: " + err.message });
  }
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (!req.url.startsWith("/api/status")) {
      log("info", `${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});

// Add magnet
app.post("/api/add", (req, res) => {
  const { magnet } = req.body;
  if (!magnet || !magnet.startsWith("magnet:")) {
    return res.status(400).json({ error: "Invalid magnet link" });
  }

  const hash = magnetToInfoHash(magnet);
  log("info", "Adding magnet", { infoHash: hash });

  const existing = client.torrents.find(
    (t) => t.magnetURI === magnet || t.infoHash === hash
  );
  if (existing) return res.json(torrentInfo(existing));

  client.add(magnet, { path: DOWNLOAD_PATH, deselect: true }, (torrent) => {
    log("info", "Torrent metadata received", {
      name: torrent.name, files: torrent.files.length,
      size: fmtBytes(torrent.length),
    });

    torrent.on("download", throttle(() => {
      log("info", "Progress", {
        name: torrent.name,
        progress: (torrent.progress * 100).toFixed(1) + "%",
        down: fmtBytes(torrent.downloadSpeed) + "/s",
        peers: torrent.numPeers,
      });
    }, 10000));

    torrent.on("done", () => {
      log("info", "Download complete, stopping seed", { name: torrent.name });
      torrent.pause();
      // Auto-start transcode for files that need it (after verifying they're real media)
      torrent.files.forEach(async (f, i) => {
        const ext = path.extname(f.name).toLowerCase();
        if (VIDEO_EXTENSIONS.includes(ext) && needsTranscode(ext)) {
          const probe = await probeMedia(diskPath(torrent, f));
          if (probe.valid) {
            startTranscode(diskPath(torrent, f), `${torrent.infoHash}:${i}`);
          } else {
            log("warn", "Skipping transcode for fake media", { name: f.name, reason: probe.reason });
          }
        }
      });
    });

    torrent.on("error", (err) => log("err", "Torrent error", { error: err.message }));
    torrent.on("wire", (wire) => log("info", "Peer connected", { addr: wire.remoteAddress, total: torrent.numPeers }));

    if (!res.headersSent) res.json(torrentInfo(torrent));
  });

  setTimeout(() => {
    if (!res.headersSent) res.status(408).json({ error: "Timed out waiting for metadata" });
  }, 30000);
});

// Duration endpoint - ffprobe the video to get total duration
app.get("/api/duration/:infoHash/:fileIndex", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });

  const file = torrent.files[parseInt(req.params.fileIndex, 10)];
  if (!file) return res.status(404).json({ error: "File not found" });

  const cacheKey = `${torrent.infoHash}:${req.params.fileIndex}`;
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
app.get("/api/stream/:infoHash/:fileIndex", async (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });

  const file = torrent.files[parseInt(req.params.fileIndex, 10)];
  if (!file) return res.status(404).json({ error: "File not found" });

  if (!isAllowedFile(file.name)) {
    return res.status(403).json({ error: "File type not allowed" });
  }

  const ext = path.extname(file.name).toLowerCase();
  const complete = isFileComplete(torrent, file);
  const filePath = diskPath(torrent, file);

  // Verify file is real media once enough data exists on disk
  if (complete || (file.downloaded > 1024 * 1024)) {
    try {
      const probe = await probeMedia(filePath);
      if (!probe.valid) {
        log("warn", "Blocked fake media file", { name: file.name, reason: probe.reason });
        return res.status(403).json({ error: "File failed media verification: " + probe.reason });
      }
    } catch {}
  }

  const jobKey = `${torrent.infoHash}:${req.params.fileIndex}`;
  const xcode = needsTranscode(ext);

  // 1) Transcoded MP4 ready - serve it (full seeking works)
  if (xcode) {
    const job = transcodeJobs.get(jobKey);
    if (job && job.done && !job.error) {
      const stat = statSync(job.outputPath);
      log("info", "Serving transcoded MP4", { file: file.name });
      return serveFile(job.outputPath, stat.size, "video/mp4", req, res);
    }
    if (job && job.error) return res.status(500).json({ error: "Transcode failed" });
    if (complete && !job) startTranscode(diskPath(torrent, file), jobKey);
  }

  // 2) Native format, complete on disk
  if (complete && !xcode) {
    log("info", "Serving from disk", { file: file.name });
    return serveFile(diskPath(torrent, file), file.length,
      ext === ".webm" ? "video/webm" : "video/mp4", req, res);
  }

  // 3) Needs transcode but not ready yet - live pipe through ffmpeg
  if (xcode) {
    const seekTo = parseFloat(req.query.t) || 0;
    log("info", "Live transcode", { file: file.name, complete, seekTo });
    return serveLiveTranscode(torrent, file, complete, req, res, seekTo);
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
    });
    const s = file.createReadStream();
    s.on("error", () => s.destroy());
    res.on("close", () => s.destroy());
    s.pipe(res);
  }
}

// Live transcode through ffmpeg (for MKV etc, before background transcode is ready)
function serveLiveTranscode(torrent, file, complete, req, res, seekTo = 0) {
  // Try to use disk file whenever possible (even partial downloads).
  // ffmpeg can read partial MKV files from disk and seek within them.
  // Only use pipe as last resort when file doesn't exist on disk.
  const filePath = diskPath(torrent, file);
  let fileOnDisk = false;
  try { fileOnDisk = statSync(filePath).size > 0; } catch {}

  const input = fileOnDisk ? filePath : "pipe:0";
  const useStdin = !fileOnDisk;

  const doSeek = seekTo > 0;
  const args = [
    ...(useStdin ? ["-analyzeduration", "5000000", "-probesize", "5000000"] : []),
    ...(doSeek && !useStdin ? ["-ss", String(seekTo)] : []),
    "-i", input,
    ...(doSeek && useStdin ? ["-ss", String(seekTo)] : []),
    // Re-encode when seeking to avoid audio/video desync at cut point
    ...(doSeek ? ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23"] : ["-c:v", "copy"]),
    "-c:a", "aac",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "-v", "warning",
    "pipe:1",
  ];

  log("info", "Live transcode", { input: fileOnDisk ? "disk" : "pipe", seekTo, doSeek });

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

  let stderrBuf = "";
  ffmpeg.stderr.on("data", (d) => { stderrBuf += d.toString(); });

  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Transfer-Encoding": "chunked",
  });

  ffmpeg.stdout.pipe(res);

  ffmpeg.on("close", (code) => {
    if (code && code !== 0 && code !== 255) {
      log("warn", "First attempt failed, retrying with full re-encode");
      const args2 = [
        ...(useStdin ? ["-analyzeduration", "5000000", "-probesize", "5000000"] : []),
        ...(doSeek && !useStdin ? ["-ss", String(seekTo)] : []),
        "-i", input,
        ...(doSeek && useStdin ? ["-ss", String(seekTo)] : []),
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "-v", "warning",
        "pipe:1",
      ];
      const ff2 = spawn("ffmpeg", args2, { stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"] });
      if (useStdin) {
        const ts2 = file.createReadStream();
        ts2.on("error", () => { ts2.destroy(); ff2.kill(); });
        ts2.pipe(ff2.stdin);
        ff2.stdin.on("error", () => {});
        res.on("close", () => { ts2.destroy(); ff2.kill(); });
      }
      ff2.stderr.on("data", () => {});
      ff2.stdout.pipe(res, { end: true });
      ff2.on("close", () => {});
      if (!useStdin) res.on("close", () => ff2.kill());
    }
  });

  res.on("close", () => {
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
      const jobKey = `${torrent.infoHash}:${i}`;
      const job = transcodeJobs.get(jobKey);
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
        duration: durationCache.get(jobKey) || null,
      };
    }),
  });
});

app.post("/api/deselect/:infoHash/:fileIndex", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });
  const fileIdx = parseInt(req.params.fileIndex, 10);
  const file = torrent.files[fileIdx];
  if (!file) return res.status(404).json({ error: "File not found" });

  // Remove from our tracking set
  const active = activeFiles.get(torrent.infoHash) || new Set();
  active.delete(fileIdx);
  activeFiles.set(torrent.infoHash, active);

  // Nuclear: clear ALL selections, then re-add only the ones still active
  torrent._selections.clear();
  for (const idx of active) {
    const f = torrent.files[idx];
    if (f && f.progress < 1) {
      torrent.select(f._startPiece, f._endPiece, 1);
    }
  }

  // If nothing active, pause the torrent to fully stop all traffic
  if (active.size === 0) {
    torrent.pause();
    log("info", "No active files, paused torrent");
  }

  log("info", "Deselected", { name: file.name, activeFiles: active.size });
  res.json({ ok: true });
});

app.post("/api/select/:infoHash/:fileIndex", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });
  const fileIdx = parseInt(req.params.fileIndex, 10);
  const file = torrent.files[fileIdx];
  if (!file) return res.status(404).json({ error: "File not found" });

  // Block non-media files from being downloaded
  if (!isAllowedFile(file.name)) {
    log("warn", "Blocked download of non-media file", { name: file.name });
    return res.status(403).json({ error: "Only video, audio, and subtitle files can be downloaded" });
  }

  // Track this file as active
  const active = activeFiles.get(torrent.infoHash) || new Set();
  active.add(fileIdx);
  activeFiles.set(torrent.infoHash, active);

  // Resume if paused
  if (torrent.paused) torrent.resume();
  file.select();
  log("info", "Selected", { name: file.name, activeFiles: active.size });
  res.json({ ok: true });
});

// List all active torrents (for persistent dashboard)
app.get("/api/torrents", (req, res) => {
  res.json(client.torrents.map((t) => ({
    infoHash: t.infoHash,
    name: t.name,
    progress: t.progress,
    downloadSpeed: t.downloadSpeed,
    uploadSpeed: t.uploadSpeed,
    numPeers: t.numPeers,
    paused: t.paused,
    done: t.progress === 1,
    totalSize: t.length,
    downloaded: t.downloaded,
    numFiles: t.files.length,
    mediaFiles: t.files.filter((f) => isAllowedFile(f.name)).length,
  })));
});

app.delete("/api/remove/:infoHash", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });
  for (const [key, job] of transcodeJobs) {
    if (key.startsWith(torrent.infoHash)) {
      if (job.process && !job.done) job.process.kill();
      transcodeJobs.delete(key);
    }
  }
  log("info", "Removing torrent", { name: torrent.name });
  torrent.destroy({ destroyStore: true });
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

function magnetToInfoHash(magnet) {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40})/);
  return m ? m[1].toLowerCase() : null;
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

// Explicit clear endpoint - deletes all downloaded files and transcodes
app.delete("/api/clear", (req, res) => {
  log("info", "Clearing all data...");
  // Kill all transcode jobs
  for (const [, job] of transcodeJobs) {
    if (job.process && !job.done) job.process.kill();
  }
  transcodeJobs.clear();
  durationCache.clear();
  // Destroy all torrents
  const promises = client.torrents.map((t) => new Promise((resolve) => {
    t.destroy({ destroyStore: true }, resolve);
  }));
  Promise.all(promises).then(() => {
    try { fs.rmSync(DOWNLOAD_PATH, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(TRANSCODE_PATH, { recursive: true, force: true }); } catch {}
    log("info", "All data cleared");
    res.json({ ok: true });
  });
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
