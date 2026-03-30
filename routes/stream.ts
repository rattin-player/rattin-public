import path from "path";
import { statSync } from "fs";
import type { Express, Request, Response, NextFunction } from "express";
import { jobKey } from "../lib/torrent-caches.js";
import { buildSeekIndex, findSeekOffset, waitForPieces } from "../lib/seek-index.js";
import { getFileOffset, getFileEndPiece, hasPiece } from "../lib/torrent-compat.js";
import { needsTranscode, isAllowedFile } from "../lib/media-utils.js";
import {
  probeMedia as _probeMedia, serveFile, serveFromTorrent,
  serveLiveTranscode as _serveLiveTranscode,
} from "../lib/transcode.js";
import type { ServerContext, ProbeResult } from "../lib/types.js";

export default function streamRoutes(app: Express, ctx: ServerContext): void {
  const {
    client, log, diskPath, isFileComplete, streamTracking,
    transcodeJobs, durationCache, seekIndexCache, seekIndexPending,
    completedFiles, activeTranscodes, probeCache,
  } = ctx;

  const probeMedia = (filePath: string): Promise<ProbeResult> => _probeMedia(filePath, probeCache, log);

  app.get("/api/stream/:infoHash/:fileIndex", streamTracking, async (req: Request, res: Response) => {
    const { infoHash, fileIndex } = req.params as Record<string, string>;
    const torrent = client.torrents.find((t) => t.infoHash === infoHash);

    // Torrent removed but file still on disk — serve directly
    if (!torrent) {
      const fileKey = `${infoHash}:${fileIndex}`;
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
                seekTo: parseFloat(req.query.t as string) || 0,
                audioStreamIdx: req.query.audio ? parseInt(req.query.audio as string, 10) : null,
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

    const file = torrent.files[parseInt(fileIndex, 10)];
    if (!file) return res.status(404).json({ error: "File not found" });

    if (!isAllowedFile(file.name)) {
      return res.status(403).json({ error: "File type not allowed" });
    }

    const ext = path.extname(file.name).toLowerCase();
    const fileIdx = parseInt(fileIndex, 10);
    const audioStreamIdx = req.query.audio ? parseInt(req.query.audio as string, 10) : null;

    // Helper: call unified serveLiveTranscode with torrent context
    const liveTranscode = (isComplete: boolean, seek: number) => _serveLiveTranscode({
      inputPath: diskPath(torrent, file),
      useStdin: !isComplete,
      createInputStream: !isComplete ? () => file.createReadStream() : undefined,
      seekTo: seek,
      audioStreamIdx,
      streamKey: `${torrent.infoHash}:${fileIdx}`,
    }, req, res, ctx);

    // Kill any previous live transcode for this file (e.g. from before a seek).
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
    const cacheKey = jobKey(torrent.infoHash, fileIndex);

    if (complete) {
      try {
        const probe = await probeMedia(filePath);
        if (!probe.valid) {
          log("warn", "Blocked fake media file", { name: file.name, reason: probe.reason });
          return res.status(403).json({ error: "File failed media verification: " + probe.reason });
        }
        // Cache duration from probe so it's immediately available
        if (probe.duration && probe.duration > 0 && !durationCache.has(cacheKey)) {
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
        seekTo: parseFloat(req.query.t as string) || 0,
        audioStreamIdx,
        streamKey: `${torrent.infoHash}:${fileIdx}`,
      }, req, res, ctx);
    }

    // 3) Needs transcode but not ready yet - live pipe through ffmpeg
    if (xcode) {
      const seekTo = parseFloat(req.query.t as string) || 0;

      // Build seek index in background (for complete files only)
      if (!seekIndexCache.has(cacheKey) && !seekIndexPending.has(cacheKey) && complete) {
        seekIndexPending.add(cacheKey);
        buildSeekIndex(diskPath(torrent, file)).then((index) => {
          seekIndexPending.delete(cacheKey);
          if (index.length > 0) {
            seekIndexCache.set(cacheKey, index);
            log("info", "Seek index built", { cacheKey, keyframes: index.length });
          }
        }).catch((err: Error) => {
          seekIndexPending.delete(cacheKey);
          log("warn", "Seek index build failed", { cacheKey, error: err.message });
        });
      }

      // Smart seek: check if pieces at seek target are on disk → use fast disk read
      // Only works with keyframe-precise offsets (Method 1). Byte estimates (Method 2)
      // are not keyframe-aligned and can land on sparse data, breaking -c:v copy mode.
      if (seekTo > 0) {
        let byteStart: number | null = null;

        // Method 1: precise keyframe index (required for disk-read + copy seek)
        if (seekIndexCache.has(cacheKey)) {
          const seekPoint = findSeekOffset(seekIndexCache.get(cacheKey)!, seekTo);
          if (seekPoint) byteStart = seekPoint.offset;
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
            log("info", "Smart seek (instant)", { seekTo, byteStart, method: seekIndexCache.has(cacheKey) ? "index" : "estimate" });
            torrent.select(firstPiece, getFileEndPiece(file), 1);
            return liveTranscode(true, seekTo);
          }

          // Pieces not ready — fetch them, then use fast path
          log("info", "Smart seek (fetching)", { seekTo, byteStart });
          const doSmartSeek = async () => {
            try {
              await waitForPieces(torrent, file, byteStart!, byteEnd, 30000);
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
}
