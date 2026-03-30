import path from "path";
import { jobKey } from "../lib/torrent-caches.js";
import {
  VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, SUBTITLE_EXTENSIONS,
  needsTranscode, isAllowedFile,
} from "../lib/media-utils.js";

export default function statusRoutes(app, ctx) {
  const {
    client, log, diskPath,
    transcodeJobs, durationCache, completedFiles,
  } = ctx;

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
}
