import express, { type Request, type Response, type NextFunction } from "express";
import path from "path";
import { statSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { tmdbCache } from "./lib/cache.js";
import { pruneOrphans, cacheStats } from "./lib/torrent-caches.js";
import { createIdleTracker } from "./lib/idle-tracker.js";
import { createContext } from "./lib/server-context.js";
import rcRoutes from "./routes/rc.js";
import tmdbRoutes from "./routes/tmdb.js";
import mediaRoutes from "./routes/media.js";
import statusRoutes from "./routes/status.js";
import searchRoutes from "./routes/search.js";
import streamRoutes from "./routes/stream.js";
import type { ServerContext, TorrentClient, IdleTracker } from "./lib/types.js";

interface CreateAppOverrides {
  __dirname?: string;
  client?: TorrentClient;
}

interface AppContext {
  app: ReturnType<typeof express>;
  client: ServerContext["client"];
  transcodeJobs: ServerContext["transcodeJobs"];
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
  idleTracker: IdleTracker;
  pcAuthToken: string;
}

export function createApp(overrides: CreateAppOverrides = {}): AppContext {
  const __dirname = overrides.__dirname || path.dirname(fileURLToPath(import.meta.url));
  const app = express();
  const ctx = createContext(overrides);
  const {
    client, transcodeJobs, durationCache, seekIndexCache, seekIndexPending,
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

// ── Idle detection — escalating cleanup when app is unused ──
const idleTracker = createIdleTracker({
  logFn: log,
  onSoftIdle() {
    // Purge expired TMDB entries
    tmdbCache.purgeExpired();
    // Destroy torrents that have no active streams
    for (const torrent of [...client.torrents]) {
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
    // Nuclear option: clear everything
    for (const [, job] of transcodeJobs) if (job.process && !job.done) job.process.kill();
    transcodeJobs.clear();
    durationCache.clear();
    seekIndexCache.clear();
    seekIndexPending.clear();
    activeFiles.clear();
    availabilityCache.clear();
    tmdbCache.clear();
    for (const [, st] of streamTracker) { if (st.idleTimer) clearTimeout(st.idleTimer); }
    streamTracker.clear();
    probeCache.clear();
    introCache.clear();
    for (const torrent of [...client.torrents]) {
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
    if (!req.url.startsWith("/api/status") && !req.url.startsWith("/api/rc/")) {
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

// Cache janitor — every 5 min, prune entries for removed torrents
const _cacheJanitor = setInterval(() => {
  const activeHashes = new Set(client.torrents.map((t) => t.infoHash));
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
    app, client, transcodeJobs, durationCache, seekIndexCache, seekIndexPending,
    activeFiles, completedFiles, streamTracker, activeTranscodes, availabilityCache,
    probeCache, introCache, rcSessions, idleTracker, pcAuthToken,
  };
}

// Detect if this file is being run directly (not imported by tests)
const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("/server.js") ||
  process.argv[1].endsWith("/server.ts")
);
if (isMain) {
  const { app, client, transcodeJobs } = createApp();

  function cleanup() {
    console.log(`[${new Date().toISOString().slice(11, 23)}] INFO  Shutting down...`);
    for (const [, job] of transcodeJobs) if (job.process && !job.done) job.process.kill();
    client.destroy(() => {
      console.log(`[${new Date().toISOString().slice(11, 23)}] INFO  Stopped`);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || "0.0.0.0";
  app.listen(PORT, HOST, () => {
    console.log(`[${new Date().toISOString().slice(11, 23)}] INFO  Rattin running at http://${HOST}:${PORT}`);
  });
}
