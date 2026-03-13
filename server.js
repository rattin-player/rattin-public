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
const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v"];
const SUBTITLE_EXTENSIONS = [".srt", ".ass", ".ssa", ".vtt", ".sub"];
const BROWSER_NATIVE = new Set([".mp4", ".m4v", ".webm"]);

const transcodeJobs = new Map();

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

  // Try remux first (fast - just repackage, no re-encoding)
  const proc = spawn("ffmpeg", [
    "-i", inputPath,
    "-c:v", "copy", "-c:a", "aac",
    "-movflags", "+faststart",
    "-y", outputPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  job.process = proc;

  proc.on("close", (code) => {
    if (code === 0) {
      job.done = true;
      log("info", "Transcode complete (remux)", { output: path.basename(outputPath) });
    } else {
      // Remux failed, re-encode
      log("info", "Remux failed, re-encoding with H.264");
      const proc2 = spawn("ffmpeg", [
        "-i", inputPath,
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-c:a", "aac",
        "-movflags", "+faststart",
        "-y", outputPath,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      job.process = proc2;

      proc2.stderr.on("data", (d) => {
        const m = d.toString().match(/time=(\S+)/);
        if (m) log("info", "Transcode progress", { time: m[1] });
      });

      proc2.on("close", (code2) => {
        if (code2 === 0) {
          job.done = true;
          log("info", "Transcode complete (re-encode)");
        } else {
          job.error = "Transcode failed";
          log("err", "Transcode failed");
        }
      });
    }
  });

  transcodeJobs.set(jobKey, job);
  return job;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
      // Auto-start transcode for files that need it
      torrent.files.forEach((f, i) => {
        const ext = path.extname(f.name).toLowerCase();
        if (VIDEO_EXTENSIONS.includes(ext) && needsTranscode(ext)) {
          startTranscode(diskPath(torrent, f), `${torrent.infoHash}:${i}`);
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

  // VTT can be served directly
  if (ext === ".vtt") {
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return createReadStream(filePath).pipe(res);
  }

  // SRT: simple text conversion (faster than ffmpeg)
  if (ext === ".srt") {
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const srtContent = fs.readFileSync(filePath, "utf-8");
      const vtt = srtToVtt(srtContent);
      return res.send(vtt);
    } catch (err) {
      log("err", "SRT conversion failed, falling back to ffmpeg", { error: err.message });
      // Fall through to ffmpeg
    }
  }

  // ASS/SSA/SUB and fallback: use ffmpeg to convert
  log("info", "Converting subtitle via ffmpeg", { file: file.name, ext });
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

  log("info", "Extracting embedded subtitle", { file: file.name, stream: streamIdx });

  const ffmpeg = spawn("ffmpeg", [
    "-i", filePath,
    "-map", `0:${streamIdx}`,
    "-f", "webvtt",
    "-v", "warning",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });

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
app.get("/api/stream/:infoHash/:fileIndex", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });

  const file = torrent.files[parseInt(req.params.fileIndex, 10)];
  if (!file) return res.status(404).json({ error: "File not found" });

  const ext = path.extname(file.name).toLowerCase();
  const complete = isFileComplete(torrent, file);
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
    log("info", "Live transcode", { file: file.name, complete });
    return serveLiveTranscode(torrent, file, complete, req, res);
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
function serveLiveTranscode(torrent, file, complete, req, res) {
  const input = complete ? diskPath(torrent, file) : "pipe:0";
  const useStdin = !complete;

  const args = [
    ...(useStdin ? ["-analyzeduration", "5000000", "-probesize", "5000000"] : []),
    "-i", input,
    "-c:v", "copy", "-c:a", "aac",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "-v", "warning",
    "pipe:1",
  ];

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
      log("warn", "Copy failed, retrying with re-encode");
      const args2 = [
        ...(useStdin ? ["-analyzeduration", "5000000", "-probesize", "5000000"] : []),
        "-i", input,
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
        isSubtitle: SUBTITLE_EXTENSIONS.includes(ext),
        transcodeStatus,
      };
    }),
  });
});

app.post("/api/deselect/:infoHash/:fileIndex", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });
  const file = torrent.files[parseInt(req.params.fileIndex, 10)];
  if (!file) return res.status(404).json({ error: "File not found" });
  file.deselect();
  // Also deselect at torrent level to ensure pieces are truly removed
  torrent.deselect(file._startPiece, file._endPiece);
  log("info", "Deselected", { name: file.name });
  res.json({ ok: true });
});

app.post("/api/select/:infoHash/:fileIndex", (req, res) => {
  const torrent = client.torrents.find((t) => t.infoHash === req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: "Torrent not found" });
  const file = torrent.files[parseInt(req.params.fileIndex, 10)];
  if (!file) return res.status(404).json({ error: "File not found" });
  file.select();
  log("info", "Selected", { name: file.name });
  res.json({ ok: true });
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
  return {
    infoHash: torrent.infoHash, name: torrent.name,
    files: torrent.files.map((f, i) => {
      const ext = path.extname(f.name).toLowerCase();
      return {
        index: i, name: f.name, length: f.length,
        isVideo: VIDEO_EXTENSIONS.includes(ext),
        isSubtitle: SUBTITLE_EXTENSIONS.includes(ext),
      };
    }),
  };
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

function cleanup() {
  log("info", "Shutting down...");
  for (const [, job] of transcodeJobs) if (job.process && !job.done) job.process.kill();
  client.destroy(() => {
    try {
      fs.rmSync(DOWNLOAD_PATH, { recursive: true, force: true });
      fs.rmSync(TRANSCODE_PATH, { recursive: true, force: true });
      log("info", "Cleaned up");
    } catch {}
    process.exit(0);
  });
  setTimeout(() => {
    try { fs.rmSync(DOWNLOAD_PATH, { recursive: true, force: true }); fs.rmSync(TRANSCODE_PATH, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log("info", `Rattin running at http://localhost:${PORT}`);
});
