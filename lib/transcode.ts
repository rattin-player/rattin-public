import path from "path";
import { createReadStream } from "fs";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import type { Readable } from "stream";
import type { Request, Response } from "express";
import type { TranscodeArgs, ProbeResult, LiveTranscodeOpts, ActiveTranscode, LogFn } from "./types.js";

const WATCHDOG_TIMEOUT = 120000;

/**
 * Build ffmpeg argument array for live transcode.
 */
export function buildTranscodeArgs({ input, useStdin, seekTo, audioStreamIdx, videoCodec, needsDownscale, isRetry }: TranscodeArgs): string[] {
  const doSeek = seekTo > 0;
  const vFilters: string[] = [];
  if (needsDownscale) vFilters.push("scale=-2:1080");
  if (isRetry) vFilters.push("format=yuv420p");

  const canCopySeek = doSeek && !useStdin;

  return [
    ...(useStdin ? ["-analyzeduration", "5000000", "-probesize", "5000000"] : []),
    ...(doSeek && !useStdin ? ["-ss", String(seekTo), "-noaccurateseek"] : []),
    "-i", input,
    ...(doSeek && useStdin ? ["-ss", String(seekTo)] : []),
    "-map", "0:v:0", "-map", audioStreamIdx !== null ? `0:${audioStreamIdx}` : "0:a:0",
    ...(canCopySeek && !isRetry
      ? ["-c:v", "copy"]
      : ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", ...(vFilters.length > 0 ? ["-vf", vFilters.join(",")] : [])]),
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
 */
export function spawnWatchdog(ffmpeg: ChildProcess, timeoutMs: number, log: LogFn, label: string = ""): () => void {
  let lastActivity = Date.now();
  ffmpeg.stdout!.on("data", () => { lastActivity = Date.now(); });
  ffmpeg.stderr!.on("data", () => { lastActivity = Date.now(); });

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
 */
export function probeMedia(filePath: string, probeCache: Map<string, ProbeResult>, log: LogFn): Promise<ProbeResult> {
  if (probeCache.has(filePath)) return Promise.resolve(probeCache.get(filePath)!);
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet", "-print_format", "json",
      "-show_format", "-show_streams",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", (code: number | null) => {
      if (code !== 0) {
        return resolve({ valid: false, reason: "ffprobe failed — not a valid media file" });
      }
      try {
        const data = JSON.parse(out);
        const fmt: string = data.format?.format_name || "";
        const streams: Array<{ codec_type: string; codec_name?: string }> = data.streams || [];
        const hasMedia = streams.some((s) =>
          s.codec_type === "video" || s.codec_type === "audio"
        );
        if (!hasMedia) {
          return resolve({ valid: false, reason: "No video or audio streams detected" });
        }
        const dur = parseFloat(data.format?.duration);
        const videoStream = streams.find((s) => s.codec_type === "video");
        const audioStream = streams.find((s) => s.codec_type === "audio");
        const result: ProbeResult = {
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

interface TorrentFileForServe {
  length: number;
  deselect(): void;
  select(): void;
  createReadStream(opts?: { start?: number; end?: number }): Readable;
}

/**
 * Serve a complete file from disk with proper range support.
 */
export function serveFile(filePath: string, fileSize: number, contentType: string, req: Request, res: Response): void {
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
 */
export function serveFromTorrent(file: TorrentFileForServe, req: Request, res: Response): void {
  const range = req.headers.range;
  const size = file.length;
  file.deselect();
  res.on("close", () => { try { file.select(); } catch {} });
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

interface LiveTranscodeContext {
  activeTranscodes: Map<string, ActiveTranscode>;
  probeCache: Map<string, ProbeResult>;
  log: LogFn;
}

/**
 * Unified live transcode through ffmpeg — works for both torrent streams and disk files.
 */
export function serveLiveTranscode(opts: LiveTranscodeOpts, req: Request, res: Response, ctx: LiveTranscodeContext): void {
  const { inputPath, useStdin, createInputStream, seekTo = 0, audioStreamIdx = null, streamKey } = opts;
  const { activeTranscodes, probeCache, log } = ctx;

  const input = useStdin ? "pipe:0" : inputPath;

  const cached = probeCache.get(inputPath);
  const needsDownscale = !!cached?.videoCodec && cached.videoCodec !== "h264";

  const args = buildTranscodeArgs({
    input, useStdin, seekTo, audioStreamIdx,
    videoCodec: cached?.videoCodec, needsDownscale, isRetry: false,
  });

  log("info", "Live transcode", { input: useStdin ? "pipe" : "disk", seekTo, doSeek: seekTo > 0 });

  const ffmpeg = spawn("ffmpeg", args, {
    stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
  });

  let torrentStream: Readable | null = null;
  if (useStdin && createInputStream) {
    torrentStream = createInputStream();
    torrentStream.on("error", () => { torrentStream!.destroy(); ffmpeg.kill(); });
    torrentStream.pipe(ffmpeg.stdin!);
    ffmpeg.stdin!.on("error", () => {});
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

  ffmpeg.stdout!.pipe(res);

  ffmpeg.on("close", (code: number | null) => {
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
        ts2.pipe(ff2.stdin!);
        ff2.stdin!.on("error", () => {});
        res.on("close", () => { clearWatchdog2(); ts2.destroy(); ff2.kill(); });
      }
      ff2.stdout!.pipe(res, { end: true });
      if (!useStdin) res.on("close", () => { clearWatchdog2(); ff2.kill(); });
    }
  });

  res.on("close", () => {
    clearWatchdog();
    if (torrentStream) torrentStream.destroy();
    ffmpeg.kill();
  });
}
