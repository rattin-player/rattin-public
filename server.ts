import express, { type Request, type Response, type NextFunction } from "express";
import path from "path";
import { statSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { sessionsPath, downloadDir } from "./lib/storage/paths.js";
import { tmdbCache } from "./lib/cache/cache.js";
import { pruneOrphans, cacheStats } from "./lib/cache/torrent-caches.js";
import { createIdleTracker } from "./lib/idle-tracker.js";
import { createApiAccessControl } from "./lib/access-control.js";
import { createContext } from "./lib/torrent/server-context.js";
import rcRoutes from "./routes/rc.js";
import tmdbRoutes from "./routes/tmdb.js";
import mediaRoutes from "./routes/media.js";
import statusRoutes from "./routes/status.js";
import searchRoutes from "./routes/search.js";
import streamRoutes from "./routes/stream.js";
import debridRoutes from "./routes/debrid.js";
import vpnRoutes from "./routes/vpn.js";
import cacheRoutes from "./routes/cache.js";
import openUrlRoutes from "./routes/open-url.js";
import storageRoutes from "./routes/storage.js";
import { sweepOldFiles } from "./lib/cache/cache-cleanup.js";
import type { ServerContext, TorrentClient, IdleTracker } from "./lib/types.js";
import type { WatchHistory } from "./lib/storage/watch-history.js";
import type { SavedList } from "./lib/storage/saved-list.js";

interface CreateAppOverrides {
  __dirname?: string;
  client?: TorrentClient;
  deferClient?: boolean;
}

interface AppContext {
  app: ReturnType<typeof express>;
  client: ServerContext["client"];
  durationCache: ServerContext["durationCache"];
  seekIndexCache: ServerContext["seekIndexCache"];
  seekIndexPending: ServerContext["seekIndexPending"];
  activeFiles: ServerContext["activeFiles"];
  completedFiles: ServerContext["completedFiles"];
  streamTracker: ServerContext["streamTracker"];
  activeTranscodes: ServerContext["activeTranscodes"];
  availabilityCache: ServerContext["availabilityCache"];
  probeCache: ServerContext["probeCache"];
  introCache: ServerContext["introCache"];
  rcSessions: ServerContext["rcSessions"];
  watchHistory: WatchHistory;
  savedList: SavedList;
  idleTracker: IdleTracker;
  pcAuthToken: string;
  initClient: ServerContext["initClient"];
}

export function createApp(overrides: CreateAppOverrides = {}): AppContext {
  const __dirname = overrides.__dirname || path.dirname(fileURLToPath(import.meta.url));
  const app = express();
  const ctx = createContext(overrides);
  const {
    durationCache, seekIndexCache, seekIndexPending,
    activeFiles, completedFiles, streamTracker, activeTranscodes,
    availabilityCache, AVAIL_TTL, introCache, probeCache, pcAuthToken,
    log, cleanupTorrentCaches, rcSessions,
  } = ctx;

app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.cookies = {};
  const hdr = req.headers.cookie;
  if (hdr) hdr.split(";").forEach((c) => {
    const [k, ...v] = c.trim().split("=");
    if (k) req.cookies[k] = decodeURIComponent(v.join("="));
  });
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", createApiAccessControl(ctx));

// ── Idle detection — escalating cleanup when app is unused ──
const idleTracker = createIdleTracker({
  logFn: log,
  onSoftIdle() {
    // Purge expired TMDB entries
    tmdbCache.purgeExpired();
    // Destroy torrents that have no active streams
    for (const torrent of [...ctx.client.torrents]) {
      const st = streamTracker.get(torrent.infoHash);
      if (!st || st.count === 0) {
        cleanupTorrentCaches(torrent.infoHash, torrent);
        log("info", "Soft idle: removing unstreamed torrent", { name: torrent.name });
        torrent.destroy({ destroyStore: false });
        if (st?.idleTimer) clearTimeout(st.idleTimer);
        streamTracker.delete(torrent.infoHash);
      }
    }
  },
  onHardIdle() {
    // Aggressive cleanup — but respect active streams
    durationCache.clear();
    seekIndexCache.clear();
    seekIndexPending.clear();
    activeFiles.clear();
    availabilityCache.clear();
    tmdbCache.clear();
    probeCache.clear();
    introCache.clear();
    const activeHashes = new Set<string>();
    for (const [hash, st] of streamTracker) {
      if (st.count > 0) {
        activeHashes.add(hash);
      } else {
        if (st.idleTimer) clearTimeout(st.idleTimer);
        streamTracker.delete(hash);
      }
    }
    for (const torrent of [...ctx.client.torrents]) {
      if (activeHashes.has(torrent.infoHash)) {
        log("info", "Hard idle: keeping actively-streamed torrent", { name: torrent.name });
        continue;
      }
      cleanupTorrentCaches(torrent.infoHash, torrent);
      log("info", "Hard idle: removing torrent", { name: torrent.name });
      torrent.destroy({ destroyStore: false });
    }
    log("info", "Hard idle cleanup complete");
  },
});
app.use("/api", idleTracker.middleware);
idleTracker.start();

// Request logging (must be before routes so it intercepts all requests)
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    if (!req.url.startsWith("/api/status") && !req.url.startsWith("/api/rc/") && !req.url.startsWith("/api/heartbeat")) {
      log("info", `${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});

rcRoutes(app, ctx);
tmdbRoutes(app, ctx);
mediaRoutes(app, ctx);
statusRoutes(app, ctx);
searchRoutes(app, ctx);
streamRoutes(app, ctx);
debridRoutes(app, ctx);
vpnRoutes(app, ctx);
cacheRoutes(app, ctx);
openUrlRoutes(app, ctx);
storageRoutes(app, ctx);

// Cache janitor — every 5 min, prune entries for removed torrents
const _cacheJanitor = setInterval(() => {
  const activeHashes = new Set(ctx.client.torrents.map((t) => t.infoHash));
  let pruned = pruneOrphans(activeHashes, statSync);
  // Availability cache has its own TTL — prune separately
  const now = Date.now();
  for (const [key, entry] of availabilityCache) {
    if (now - entry.ts > AVAIL_TTL) { availabilityCache.delete(key); pruned++; }
  }
  if (pruned > 0) log("info", "Cache janitor", { pruned, ...cacheStats(), availability: availabilityCache.size });
}, 5 * 60 * 1000);
if (_cacheJanitor.unref) _cacheJanitor.unref();

const indexHtml = readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
app.get("/{*splat}", (_req: Request, res: Response) => {
  res.type("html").send(indexHtml);
});

  return {
    app, get client() { return ctx.client; }, initClient: ctx.initClient,
    durationCache, seekIndexCache, seekIndexPending,
    activeFiles, completedFiles, streamTracker, activeTranscodes, availabilityCache,
    probeCache, introCache, rcSessions,
    watchHistory: ctx.watchHistory, savedList: ctx.savedList,
    idleTracker, pcAuthToken,
  };
}

// Detect if this file is being run directly (not imported by tests)
const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("/server.js") ||
  process.argv[1].endsWith("/server.ts") ||
  process.argv[1].endsWith("\\server.js") ||
  process.argv[1].endsWith("\\server.ts")
);
// ── Session persistence (for VPN toggle restarts) ─────────────────
const SESSIONS_PATH = sessionsPath();

interface SessionEntry { infoHash: string; magnetURI: string; fileIndex: number }

function dumpSessions(client: ServerContext["client"]): void {
  try {
    const sessions: SessionEntry[] = client.torrents.map((t) => ({
      infoHash: t.infoHash,
      magnetURI: t.magnetURI,
      fileIndex: 0,
    }));
    mkdirSync(path.dirname(SESSIONS_PATH), { recursive: true });
    writeFileSync(SESSIONS_PATH, JSON.stringify(sessions));
  } catch {}
}

function restoreSessions(client: ServerContext["client"], downloadPath: string): void {
  try {
    const raw = readFileSync(SESSIONS_PATH, "utf8");
    const sessions = JSON.parse(raw) as SessionEntry[];
    for (const s of sessions) {
      if (s.magnetURI && !client.torrents.find((t) => t.infoHash === s.infoHash)) {
        client.add(s.magnetURI, { path: downloadPath, deselect: true });
      }
    }
    // Clear after restore — single use
    writeFileSync(SESSIONS_PATH, "[]");
  } catch {}
}

if (isMain) {
  const ctx = createApp({ deferClient: true });
  const { app, activeTranscodes } = ctx;

  function cleanup() {
    console.log(`[${new Date().toISOString().slice(11, 23)}] INFO  Shutting down...`);
    // Flush persistent stores before exit
    ctx.watchHistory.shutdown();
    ctx.savedList.shutdown();
    dumpSessions(ctx.client);
    // Kill any active ffmpeg transcode processes so they don't linger as orphans
    for (const [key, entry] of activeTranscodes) {
      entry.cleanup();
      activeTranscodes.delete(key);
    }
    ctx.client.destroy(() => {
      console.log(`[${new Date().toISOString().slice(11, 23)}] INFO  Stopped`);
      process.exit(0);
    });
    // Safety timeout must be shorter than Qt shell's 3s waitForFinished,
    // otherwise Qt escalates to SIGKILL on tsx and this process becomes
    // an orphan that lingers until this timeout fires.
    setTimeout(() => process.exit(1), 2000);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || "127.0.0.1";
  app.listen(PORT, HOST, () => {
    console.log(`[${new Date().toISOString().slice(11, 23)}] INFO  Rattin running at http://${HOST}:${PORT}`);

    // Phase 2: heavy init — runs after server is listening so the
    // Qt shell's health-check poll succeeds immediately.
    const client = ctx.initClient();

    const dlDir = downloadDir();
    sweepOldFiles(dlDir, (level, msg, data) => {
      const ts = new Date().toISOString().slice(11, 23);
      const prefix = ({ info: "INFO", warn: "WARN", err: " ERR" } as Record<string, string>)[level] || level;
      const extra = data ? " " + JSON.stringify(data) : "";
      console.log(`[${ts}] ${prefix}  ${msg}${extra}`);
    }).then((n) => {
      if (n > 0) console.log(`[${new Date().toISOString().slice(11, 23)}] INFO  Swept ${n} stale cache entries`);
    });

    restoreSessions(client, dlDir);
  });
}
