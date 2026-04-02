import path from "path";
import { statSync } from "fs";
import type { Express, Request, Response, NextFunction } from "express";
import { isAllowedFile, SUBTITLE_EXTENSIONS } from "../lib/media-utils.js";
import {
  serveFile, serveFromTorrent,
  serveLiveTranscode as _serveLiveTranscode,
} from "../lib/transcode.js";
import type { ServerContext } from "../lib/types.js";

export default function streamRoutes(app: Express, ctx: ServerContext): void {
  const {
    client, log, diskPath, isFileComplete, streamTracking,
    durationCache,
    completedFiles, activeTranscodes, probeCache,
  } = ctx;

  const probeMedia = (filePath: string) => import("../lib/transcode.js").then(m => m.probeMedia(filePath, probeCache, log));

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
    // but keep subtitle files selected — they're tiny and needed for playback
    torrent.files.forEach((f, i) => {
      if (i === fileIdx) return;
      const ext = path.extname(f.name).toLowerCase();
      if (SUBTITLE_EXTENSIONS.includes(ext)) {
        // Use deselect then torrent.select with priority to force download
        try {
          f.deselect();
          const startPiece = Math.floor(f.offset / torrent.pieceLength);
          const endPiece = Math.floor((f.offset + f.length - 1) / torrent.pieceLength);
          torrent.select(startPiece, endPiece, 1);
        } catch {}
      } else if (f.length > 0) {
        try { f.deselect(); } catch {}
      }
    });

    const complete = isFileComplete(torrent, file);
    const filePath = diskPath(torrent, file);

    // Verify file is real media — only when complete.
    const { jobKey } = await import("../lib/torrent-caches.js");
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

    // Complete on disk — serve directly (mpv handles all formats)
    if (complete && audioStreamIdx === null) {
      log("info", "Serving from disk", { file: file.name });
      return serveFile(diskPath(torrent, file), file.length,
        ext === ".webm" ? "video/webm" : "video/mp4", req, res);
    }

    // Complete + audio track override — demux with ffmpeg
    if (complete && audioStreamIdx !== null) {
      log("info", "Serving with audio track override", { file: file.name, audioStreamIdx });
      return _serveLiveTranscode({
        inputPath: diskPath(torrent, file),
        useStdin: false,
        seekTo: parseFloat(req.query.t as string) || 0,
        audioStreamIdx,
        streamKey: `${torrent.infoHash}:${fileIdx}`,
      }, req, res, ctx);
    }

    // Still downloading — WebTorrent stream
    log("info", "Streaming via WebTorrent", { file: file.name });
    serveFromTorrent(file, req, res);
  });

  // ── Debrid stream proxy ──────────────────────────────────────────
  // Proxies a debrid direct download URL with range request support.
  app.get("/api/debrid-stream", async (req: Request, res: Response) => {
    const url = req.query.url as string;
    if (!url) return res.status(400).json({ error: "url required" });

    const seekTo = parseFloat(req.query.t as string) || 0;
    const audioStreamIdx = req.query.audio ? parseInt(req.query.audio as string, 10) : null;

    // Determine file extension for content type
    let ext: string;
    try {
      ext = path.extname(new URL(url).pathname).toLowerCase() || ".mkv";
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }

    if (seekTo > 0 || audioStreamIdx !== null) {
      // Transcode path — ffmpeg for seeking or audio demux
      log("info", "Debrid stream via transcode", { ext, seekTo });
      return _serveLiveTranscode({
        inputPath: url,
        useStdin: false,
        seekTo,
        audioStreamIdx,
        streamKey: null,
      }, req, res, ctx);
    }

    // Direct proxy with range support
    try {
      const headers: Record<string, string> = {};
      if (req.headers.range) headers["Range"] = req.headers.range;

      const upstream = await fetch(url, { headers });
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(upstream.status).json({ error: "debrid_stream_failed" });
      }

      res.status(upstream.status);

      // Forward relevant headers
      const fwd = ["content-type", "content-length", "content-range", "accept-ranges"];
      for (const h of fwd) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      if (!upstream.headers.get("content-type")) {
        res.setHeader("Content-Type", ext === ".webm" ? "video/webm" : "video/mp4");
      }

      // Pipe the body
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            if (!res.write(value)) {
              await new Promise<void>((r) => res.once("drain", r));
            }
          }
        };
        res.on("close", () => reader.cancel());
        pump().catch(() => res.end());
      } else {
        res.end();
      }
    } catch (err) {
      log("err", "Debrid stream proxy failed", { error: (err as Error).message });
      if (!res.headersSent) res.status(502).json({ error: "debrid_proxy_failed" });
    }
  });
}
