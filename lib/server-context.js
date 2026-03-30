import path from "path";
import { statSync } from "fs";
import WebTorrent from "webtorrent";
import crypto from "crypto";
import { BoundedMap } from "./bounded-map.js";
import { registerCache, cleanupHash } from "./torrent-caches.js";

export function createContext(overrides = {}) {
  const client = overrides.client || new WebTorrent();

  const DOWNLOAD_PATH = "/tmp/rattin";
  const TRANSCODE_PATH = "/tmp/rattin-transcoded";

  const transcodeJobs = new Map();
  const durationCache = new Map(); // "infoHash:fileIndex" -> seconds
  const seekIndexCache = new BoundedMap(20); // "infoHash:fileIndex" -> [{ time, offset }, ...]
  const seekIndexPending = new Set(); // jobKeys currently being indexed (prevents duplicate attempts)
  const activeFiles = new Map(); // "infoHash" -> Set of fileIndex
  const completedFiles = new Map(); // "infoHash:fileIndex" -> { path, size, name }
  const streamTracker = new Map(); // infoHash -> { count, idleTimer }
  const activeTranscodes = new Map(); // "infoHash:fileIndex" -> { ffmpeg, torrentStream, cleanup() }
  const availabilityCache = new Map(); // "title:year" -> { available: bool, ts: number }
  const AVAIL_TTL = 2 * 60 * 60 * 1000; // 2 hours

  registerCache("transcodeJobs", transcodeJobs, "hash:index");
  registerCache("durationCache", durationCache, "hash:index");
  registerCache("seekIndexCache", seekIndexCache, "hash:index");
  registerCache("seekIndexPending", seekIndexPending, "hash:index");
  registerCache("activeFiles", activeFiles, "hash");

  const introCache = new BoundedMap(100); // "tmdbId:season" -> { intro_start, intro_end, source }
  // Not registered with torrent-caches — keyed by tmdbId, not infoHash.
  // BoundedMap LRU eviction handles size; entries are cross-torrent so cleanup-by-hash doesn't apply.

  const probeCache = new BoundedMap(50); // filePath -> result
  registerCache("probeCache", probeCache, "path");

  // Stable token generated once per server start. After the PC passes nginx
  // basic auth once, the app sets a 30-day cookie with this token. Nginx's
  // auth_request accepts the cookie on subsequent requests, skipping the
  // basic auth prompt.
  const pcAuthToken = crypto.randomBytes(16).toString("hex");

  // ── Remote Control sessions ──────────────────────────────────────────
  const rcSessions = new Map(); // sessionId -> { playerClient, remoteClients, playbackState, lastActivity }

  // Expire sessions after 24h of inactivity
  const _rcExpiry = setInterval(() => {
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
  if (_rcExpiry.unref) _rcExpiry.unref();

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

  // Clean all caches for a torrent — delegates to central registry
  function cleanupTorrentCaches(infoHash, torrent) {
    // Persist paths for completed files so they can be served after torrent removal
    if (torrent?.files) {
      for (let i = 0; i < torrent.files.length; i++) {
        const f = torrent.files[i];
        const fp = diskPath(torrent, f);
        try {
          const stat = statSync(fp);
          if (stat.size === f.length && stat.size > 0) {
            completedFiles.set(`${infoHash}:${i}`, { path: fp, size: f.length, name: f.name });
          }
        } catch {}
      }
    }
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
    // All streams closed — kill background transcodes after 2 min
    // If torrent has completed files on disk, just pause it instead of destroying
    // (destroying forces a slow re-add from peers next time the user plays it)
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
        const hasCompleteFiles = torrent.files.some((f) => {
          try { return f.length > 0 && statSync(diskPath(torrent, f)).size === f.length; }
          catch { return false; }
        });
        if (hasCompleteFiles) {
          if (!torrent.paused) torrent.pause();
          log("info", "Paused idle torrent (files on disk)", { name: torrent.name });
        } else {
          cleanupTorrentCaches(infoHash, torrent);
          log("info", "Auto-removing idle torrent", { name: torrent.name });
          torrent.destroy({ destroyStore: false });
        }
      }
      streamTracker.delete(infoHash);
    }, 2 * 60 * 1000);
    if (entry.idleTimer.unref) entry.idleTimer.unref();
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

  return {
    client, DOWNLOAD_PATH, TRANSCODE_PATH,
    transcodeJobs, durationCache, seekIndexCache, seekIndexPending,
    activeFiles, completedFiles, streamTracker, activeTranscodes,
    availabilityCache, AVAIL_TTL, introCache, probeCache, pcAuthToken,
    rcSessions,
    log, diskPath, isFileComplete, cleanupTorrentCaches,
    trackStreamOpen, trackStreamClose, streamTracking,
  };
}
