import path from "path";
import fs from "fs";
import { createReadStream } from "fs";
import { spawn } from "child_process";

const WATCHDOG_TIMEOUT = 120000;

/**
 * Build ffmpeg argument array for live transcode.
 * @param {Object} opts
 * @param {string} opts.input - file path or "pipe:0"
 * @param {boolean} opts.useStdin - true when piping from torrent stream
 * @param {number} opts.seekTo - seconds to seek to (0 = no seek)
 * @param {number|null} opts.audioStreamIdx - audio stream index override
 * @param {string} opts.videoCodec - detected video codec from probe cache
 * @param {boolean} opts.needsDownscale - whether to downscale to 1080p
 * @param {boolean} opts.isRetry - if true, always add format=yuv420p filter
 */
export function buildTranscodeArgs({ input, useStdin, seekTo, audioStreamIdx, videoCodec, needsDownscale, isRetry }) {
  const doSeek = seekTo > 0;
  const browserSafeCodec = !videoCodec || videoCodec === "h264";

  const vFilters = [];
  if (needsDownscale) vFilters.push("scale=-2:1080");
  if (!browserSafeCodec || isRetry) vFilters.push("format=yuv420p");

  return [
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
    "-progress", "pipe:2",
    "pipe:1",
  ];
}

/**
 * Start a watchdog timer that kills ffmpeg if no activity for WATCHDOG_TIMEOUT ms.
 * Returns a cleanup function that clears the interval.
 * @param {import("child_process").ChildProcess} ffmpeg
 * @param {number} timeoutMs
 * @param {Function} log
 * @param {string} [label] - label for log message
 */
export function spawnWatchdog(ffmpeg, timeoutMs, log, label = "") {
  let lastActivity = Date.now();
  ffmpeg.stdout.on("data", () => { lastActivity = Date.now(); });
  ffmpeg.stderr.on("data", () => { lastActivity = Date.now(); });

  const interval = setInterval(() => {
    if (Date.now() - lastActivity > timeoutMs) {
      clearInterval(interval);
      log("warn", `Watchdog: killing stale ffmpeg${label ? " (" + label + ")" : ""} (no activity for ${timeoutMs / 1000}s)`);
      ffmpeg.kill("SIGKILL");
    }
  }, 10000);

  const clear = () => clearInterval(interval);
  ffmpeg.on("close", clear);
  return clear;
}

/**
 * Verify a file is actually media by probing its content with ffprobe.
 * Returns { valid, format, streams, duration, videoCodec, audioCodec } or { valid: false, reason }.
 * @param {string} filePath
 * @param {Map} probeCache
 * @param {Function} log
 */
export function probeMedia(filePath, probeCache, log) {
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

/**
 * Start background transcode to a proper MP4 with faststart (moov at beginning).
 * @param {string} inputPath
 * @param {string} cacheKey
 * @param {Object} ctx - { TRANSCODE_PATH, transcodeJobs, probeCache, log }
 * @param {number|null} audioStreamIdx
 */
export function startTranscode(inputPath, cacheKey, ctx, audioStreamIdx = null) {
  const { TRANSCODE_PATH, transcodeJobs, probeCache, log } = ctx;
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

/**
 * Serve a complete file from disk with proper range support.
 * @param {string} filePath
 * @param {number} fileSize
 * @param {string} contentType
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export function serveFile(filePath, fileSize, contentType, req, res) {
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

/**
 * Stream from WebTorrent (still downloading, native format).
 * Deselects file before creating the stream so the FileIterator's internal
 * selection (priority 1) becomes the sole active selection.
 * @param {Object} file - WebTorrent file
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export function serveFromTorrent(file, req, res) {
  const range = req.headers.range;
  const size = file.length;
  file.deselect();
  res.on("close", () => file.select());
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

/**
 * Unified live transcode through ffmpeg — works for both torrent streams and disk files.
 * @param {Object} opts
 * @param {string} opts.inputPath - file path on disk
 * @param {boolean} opts.useStdin - pipe from torrent stream (incomplete file)
 * @param {Function} [opts.createInputStream] - function that returns a readable stream (for stdin mode)
 * @param {number} opts.seekTo - seconds to seek to
 * @param {number|null} opts.audioStreamIdx - audio stream index override (null for default)
 * @param {string|null} opts.streamKey - "infoHash:fileIndex" for activeTranscodes tracking (null for disk-only)
 * @param {Object} ctx - { activeTranscodes, probeCache, log }
 */
export function serveLiveTranscode(opts, req, res, ctx) {
  const { inputPath, useStdin, createInputStream, seekTo = 0, audioStreamIdx = null, streamKey } = opts;
  const { activeTranscodes, probeCache, log } = ctx;

  const input = useStdin ? "pipe:0" : inputPath;

  const cached = probeCache.get(inputPath);
  const browserSafeCodec = !cached?.videoCodec || cached.videoCodec === "h264";
  const needsDownscale = !browserSafeCodec && cached?.videoCodec;

  const args = buildTranscodeArgs({
    input, useStdin, seekTo, audioStreamIdx,
    videoCodec: cached?.videoCodec, needsDownscale, isRetry: false,
  });

  log("info", "Live transcode", { input: useStdin ? "pipe" : "disk", seekTo, doSeek: seekTo > 0 });

  const ffmpeg = spawn("ffmpeg", args, {
    stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
  });

  let torrentStream = null;
  if (useStdin && createInputStream) {
    torrentStream = createInputStream();
    torrentStream.on("error", () => { torrentStream.destroy(); ffmpeg.kill(); });
    torrentStream.pipe(ffmpeg.stdin);
    ffmpeg.stdin.on("error", () => {});
  }

  // Register this transcode so it can be killed if a new request arrives
  const cleanup = () => {
    if (torrentStream) torrentStream.destroy();
    ffmpeg.kill("SIGKILL");
  };
  if (streamKey) {
    activeTranscodes.set(streamKey, { ffmpeg, torrentStream, cleanup });
    ffmpeg.on("close", () => activeTranscodes.delete(streamKey));
  }

  const clearWatchdog = spawnWatchdog(ffmpeg, WATCHDOG_TIMEOUT, log, streamKey ? undefined : "disk fallback");

  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Transfer-Encoding": "chunked",
    "X-Accel-Buffering": "no",
    "Cache-Control": "no-cache",
  });

  ffmpeg.stdout.pipe(res);

  ffmpeg.on("close", (code) => {
    if (code && code !== 0 && code !== 255 && !res.destroyed) {
      log("warn", "First attempt failed, retrying with full re-encode");
      const args2 = buildTranscodeArgs({
        input, useStdin, seekTo, audioStreamIdx,
        videoCodec: cached?.videoCodec, needsDownscale, isRetry: true,
      });
      const ff2 = spawn("ffmpeg", args2, { stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"] });

      if (streamKey) {
        activeTranscodes.set(streamKey, { ffmpeg: ff2, torrentStream: null, cleanup: () => ff2.kill("SIGKILL") });
        ff2.on("close", () => activeTranscodes.delete(streamKey));
      }

      const clearWatchdog2 = spawnWatchdog(ff2, WATCHDOG_TIMEOUT, log, "retry");

      if (useStdin && createInputStream) {
        const ts2 = createInputStream();
        ts2.on("error", () => { ts2.destroy(); ff2.kill(); });
        ts2.pipe(ff2.stdin);
        ff2.stdin.on("error", () => {});
        res.on("close", () => { clearWatchdog2(); ts2.destroy(); ff2.kill(); });
      }
      ff2.stdout.pipe(res, { end: true });
      if (!useStdin) res.on("close", () => { clearWatchdog2(); ff2.kill(); });
    }
  });

  res.on("close", () => {
    clearWatchdog();
    if (torrentStream) torrentStream.destroy();
    ffmpeg.kill();
  });
}
