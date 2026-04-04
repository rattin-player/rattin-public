import path from "path";
import type { Express, Request, Response } from "express";
import { jobKey } from "../lib/cache/torrent-caches.js";
import {
  VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, SUBTITLE_EXTENSIONS,
  isAllowedFile,
} from "../lib/media/media-utils.js";
import type { ServerContext, Torrent } from "../lib/types.js";
import { getActiveDebridFiles } from "../lib/torrent/debrid.js";

export default function statusRoutes(app: Express, ctx: ServerContext): void {
  const {
    log, diskPath,
    durationCache, completedFiles,
  } = ctx;
  // Access ctx.client via getter (not destructured) so deferred init is visible
  const client = () => ctx.client;

  function torrentInfo(torrent: Torrent) {
    const blocked: string[] = [];
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

  app.get("/api/status/:infoHash", (req: Request, res: Response) => {
    const { infoHash } = req.params as Record<string, string>;
    const torrent = client().torrents.find((t) => t.infoHash === infoHash);
    if (!torrent) {
      const diskFiles: Array<Record<string, unknown>> = [];
      for (const [key, info] of completedFiles) {
        if (key.startsWith(infoHash + ":")) {
          const idx = parseInt(key.split(":")[1], 10);
          const ext = path.extname(info.name).toLowerCase();
          diskFiles.push({
            index: idx, name: info.name, length: info.size,
            downloaded: info.size, progress: 1,
            isVideo: VIDEO_EXTENSIONS.includes(ext),
            isAudio: AUDIO_EXTENSIONS.includes(ext),
            isSubtitle: SUBTITLE_EXTENSIONS.includes(ext),
            isAllowed: isAllowedFile(info.name),
            duration: durationCache.get(key) || null,
          });
        }
      }
      if (diskFiles.length > 0) {
        return res.json({
          infoHash, name: "(cached on disk)",
          downloadSpeed: 0, uploadSpeed: 0, progress: 1,
          downloaded: 0, totalSize: 0, numPeers: 0, timeRemaining: 0,
          files: diskFiles,
        });
      }
      // Debrid fallback: return file list from RD torrent info
      const debridFiles = getActiveDebridFiles(infoHash);
      if (debridFiles.length > 0) {
        const files = debridFiles.map((f, i) => {
          const ext = path.extname(f.path).toLowerCase();
          return {
            index: f.id - 1, // RD uses 1-based, we use 0-based
            name: f.path.replace(/^\//, ""),
            path: f.path.replace(/^\//, ""),
            length: f.bytes,
            downloaded: f.bytes,
            progress: 1,
            isVideo: VIDEO_EXTENSIONS.includes(ext),
            isAudio: AUDIO_EXTENSIONS.includes(ext),
            isSubtitle: SUBTITLE_EXTENSIONS.includes(ext),
            isAllowed: isAllowedFile(f.path),
            duration: null,
          };
        });
        return res.json({
          infoHash, name: "(debrid)",
          downloadSpeed: 0, uploadSpeed: 0, progress: 1,
          downloaded: 0, totalSize: 0, numPeers: 0, timeRemaining: 0,
          files,
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
      timeRemaining: (torrent as unknown as { timeRemaining: number }).timeRemaining,
      files: torrent.files.map((f, i) => {
        const ext = path.extname(f.name).toLowerCase();
        const key = jobKey(torrent.infoHash, i);
        return {
          index: i, name: f.name, path: f.path, length: f.length,
          downloaded: f.downloaded,
          progress: f.length > 0 ? f.downloaded / f.length : 0,
          isVideo: VIDEO_EXTENSIONS.includes(ext),
          isAudio: AUDIO_EXTENSIONS.includes(ext),
          isSubtitle: SUBTITLE_EXTENSIONS.includes(ext),
          isAllowed: isAllowedFile(f.name),
          duration: durationCache.get(key) || null,
        };
      }),
    });
  });

  // Lightweight heartbeat — keeps idle tracker alive (middleware calls touch())
  app.get("/api/heartbeat", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // Pause all other torrents, resume this one
  app.post("/api/set-active/:infoHash", (req: Request, res: Response) => {
    const { infoHash: activeHash } = req.params as Record<string, string>;
    for (const t of client().torrents) {
      if (t.infoHash === activeHash) {
        if (t.paused) t.resume();
      } else {
        // Deselect all files to stop active piece transfers, then pause
        t.files?.forEach((f) => { try { f.deselect(); } catch {} });
        if (!t.paused) t.pause();
        log("info", "Paused inactive torrent", { name: t.name });
      }
    }
    res.json({ ok: true });
  });
}
