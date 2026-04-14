import path from "path";
import { statSync } from "fs";
// @ts-expect-error — no @types/webtorrent available
import WebTorrent from "webtorrent";
import crypto from "crypto";
import { BoundedMap } from "../cache/bounded-map.js";
import { registerCache, cleanupHash } from "../cache/torrent-caches.js";
import { downloadDir, transcodeDir, dataDir } from "../storage/paths.js";
import { JsonStore } from "../storage/store.js";
import { WatchHistory } from "../storage/watch-history.js";
import { SavedList } from "../storage/saved-list.js";
import type { WatchRecord } from "../storage/watch-history.js";
import type { SavedItem } from "../storage/saved-list.js";
import type { Request, Response, NextFunction } from "express";
import type {
  CompletedFile, StreamEntry, ActiveTranscode,
  AvailEntry, IntroEntry, ProbeResult, RCSession, SeekEntry,
  Torrent, TorrentFile, TorrentClient, LogLevel, ServerContext,
} from "../types.js";

interface CreateContextOverrides {
  client?: TorrentClient;
  deferClient?: boolean;
}

export function createContext(overrides: CreateContextOverrides = {}): ServerContext {
  let clientReady = !overrides.deferClient;
  let client: TorrentClient = overrides.client || (overrides.deferClient
    ? { torrents: [], destroy(cb?: (err?: Error) => void) { cb?.(); } } as unknown as TorrentClient
    : new WebTorrent() as unknown as TorrentClient);

  function initClient(): TorrentClient {
    if (clientReady) return client;
    clientReady = true;
    if (!overrides.client) {
      client = new WebTorrent() as unknown as TorrentClient;
    }
    return client;
  }

  const DOWNLOAD_PATH = downloadDir();
  const TRANSCODE_PATH = transcodeDir();

  const durationCache = new Map<string, number>(); // "infoHash:fileIndex" -> seconds
  const seekIndexCache = new BoundedMap<SeekEntry[]>(20); // "infoHash:fileIndex" -> [{ time, offset }, ...]
  const seekIndexPending = new Set<string>(); // jobKeys currently being indexed (prevents duplicate attempts)
  const activeFiles = new Map<string, Set<number>>(); // "infoHash" -> Set of fileIndex
  const completedFiles = new Map<string, CompletedFile>(); // "infoHash:fileIndex" -> { path, size, name }
  const streamTracker = new Map<string, StreamEntry>(); // infoHash -> { count, idleTimer }
  const activeTranscodes = new Map<string, ActiveTranscode>(); // "infoHash:fileIndex" -> { ffmpeg, torrentStream, cleanup() }
  const availabilityCache = new Map<string, AvailEntry>(); // "title:year" -> { available: bool, ts: number }
  const AVAIL_TTL = 2 * 60 * 60 * 1000; // 2 hours

  registerCache("durationCache", durationCache as Map<string, unknown>, "hash:index");
  registerCache("seekIndexCache", seekIndexCache as unknown as Map<string, unknown>, "hash:index");
  registerCache("seekIndexPending", seekIndexPending, "hash:index");
  registerCache("activeFiles", activeFiles as Map<string, unknown>, "hash");

  const introCache = new BoundedMap<IntroEntry>(100); // "tmdbId:season" -> { intro_start, intro_end, source }
  // Not registered with torrent-caches — keyed by tmdbId, not infoHash.
  // BoundedMap LRU eviction handles size; entries are cross-torrent so cleanup-by-hash doesn't apply.

  const probeCache = new BoundedMap<ProbeResult>(50); // filePath -> result
  registerCache("probeCache", probeCache as unknown as Map<string, unknown>, "path");

  // ── Persistent storage ──────────────────────────────────────────────
  const profileDir = dataDir();
  const watchHistoryStore = new JsonStore<WatchRecord>(path.join(profileDir, "watch-history.json"));
  const watchHistory = new WatchHistory(watchHistoryStore);
  const savedListStore = new JsonStore<SavedItem>(path.join(profileDir, "saved-list.json"));
  const savedList = new SavedList(savedListStore);

  // Stable token generated once per server start. After the PC passes nginx
  // basic auth once, the app sets a 30-day cookie with this token. Nginx's
  // auth_request accepts the cookie on subsequent requests, skipping the
  // basic auth prompt.
  const pcAuthToken = crypto.randomBytes(16).toString("hex");

  // ── Remote Control sessions ──────────────────────────────────────────
  const rcSessions = new Map<string, RCSession>(); // sessionId -> { playerClient, remoteClients, playbackState, lastActivity }

  // Sessions persist indefinitely — only torn down when the desktop creates a new
  // session or explicitly ends one. Cookies are set to 10 years.

  function log(level: LogLevel, msg: string, data?: unknown): void {
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = ({ info: "INFO", warn: "WARN", err: " ERR" } as Record<string, string>)[level] || level;
    const extra = data ? " " + JSON.stringify(data) : "";
    console.log(`[${ts}] ${prefix}  ${msg}${extra}`);
  }

  function diskPath(torrent: Torrent, file: TorrentFile): string {
    return path.join(DOWNLOAD_PATH, file.path);
  }

  function isFileComplete(torrent: Torrent, file: TorrentFile): boolean {
    if (file.length > 0 && file.downloaded < file.length) return false;
    try {
      const stat = statSync(diskPath(torrent, file));
      return stat.size === file.length;
    } catch {
      return false;
    }
  }

  // Clean all caches for a torrent — delegates to central registry
  function cleanupTorrentCaches(infoHash: string, torrent?: Torrent): void {
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
        } catch { /* file doesn't exist */ }
      }
    }
    const filePaths = torrent?.files
      ? torrent.files.map((f: TorrentFile) => diskPath(torrent, f))
      : [];
    cleanupHash(infoHash, filePaths);
  }

  function trackStreamOpen(infoHash: string): void {
    const entry = streamTracker.get(infoHash) || { count: 0, idleTimer: null };
    entry.count++;
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    streamTracker.set(infoHash, entry);
  }

  function trackStreamClose(infoHash: string): void {
    const entry = streamTracker.get(infoHash);
    if (!entry) return;
    entry.count = Math.max(0, entry.count - 1);
    if (entry.count > 0) return;
    // All streams closed — kill background transcodes after 2 min
    // If torrent has completed files on disk, just pause it instead of destroying
    // (destroying forces a slow re-add from peers next time the user plays it)
    entry.idleTimer = setTimeout(() => {
      const torrent = client.torrents.find((t: Torrent) => t.infoHash === infoHash);
      if (torrent) {
        const hasCompleteFiles = torrent.files.some((f: TorrentFile) => {
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
  function streamTracking(req: Request, res: Response, next: NextFunction): void {
    const infoHash = req.params.infoHash as string | undefined;
    if (!infoHash) return next();
    trackStreamOpen(infoHash);
    res.on("close", () => trackStreamClose(infoHash));
    next();
  }

  return {
    get client() { return client; },
    initClient,
    DOWNLOAD_PATH, TRANSCODE_PATH,
    durationCache, seekIndexCache, seekIndexPending,
    activeFiles, completedFiles, streamTracker, activeTranscodes,
    availabilityCache, AVAIL_TTL, introCache, probeCache, pcAuthToken,
    rcSessions, watchHistory, savedList,
    log, diskPath, isFileComplete, cleanupTorrentCaches,
    trackStreamOpen, trackStreamClose, streamTracking,
  };
}
