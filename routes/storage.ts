import type { Express, Request, Response } from "express";
import type { ServerContext } from "../lib/types.js";

export default function storageRoutes(app: Express, ctx: ServerContext): void {
  const { watchHistory, savedList } = ctx;

  // ── Watch History ──────────────────────────────────────────────────

  const VALID_MEDIA_TYPES = ["movie", "tv"];

  // Accept both PUT (normal) and POST (sync XHR on unmount)
  function handleProgress(req: Request, res: Response) {
    const { tmdbId, mediaType, title, posterPath, season, episode, episodeTitle, position, duration } = req.body;
    if (!tmdbId || !mediaType || !title || position == null) {
      res.status(400).json({ error: "missing_fields" });
      return;
    }
    if (!VALID_MEDIA_TYPES.includes(mediaType)) {
      res.status(400).json({ error: "invalid_media_type" });
      return;
    }
    if (isNaN(Number(tmdbId))) {
      res.status(400).json({ error: "invalid_tmdb_id" });
      return;
    }
    const pos = Number(position);
    const dur = Number(duration || 0);
    watchHistory.recordProgress({
      tmdbId: Number(tmdbId),
      mediaType,
      title,
      posterPath: posterPath ?? null,
      season: season != null ? Number(season) : undefined,
      episode: episode != null ? Number(episode) : undefined,
      episodeTitle: episodeTitle ?? undefined,
      position: pos,
      duration: dur,
      finished: false, // computed by recordProgress
      updatedAt: "",   // set by recordProgress
    });
    res.json({ ok: true });
  }
  app.put("/api/watch-history/progress", handleProgress);
  app.post("/api/watch-history/progress", handleProgress);

  app.get("/api/watch-history/continue", (_req: Request, res: Response) => {
    res.json({ items: watchHistory.getContinueWatching() });
  });

  app.get("/api/watch-history/recent", (_req: Request, res: Response) => {
    res.json({ items: watchHistory.getRecentlyWatched() });
  });

  app.get("/api/watch-history/series/:tmdbId", (req: Request, res: Response) => {
    const tmdbId = Number(req.params.tmdbId);
    res.json({ episodes: watchHistory.getSeriesProgress(tmdbId) });
  });

  app.get("/api/watch-history/resume/:tmdbId", (req: Request, res: Response) => {
    const tmdbId = Number(req.params.tmdbId);
    const mediaType = (req.query.mediaType as string) || "movie";
    const point = watchHistory.getResumePoint(tmdbId, mediaType);
    res.json({ resumePoint: point });
  });

  app.get("/api/watch-history/progress/:mediaType/:tmdbId", (req: Request, res: Response) => {
    const mediaType = req.params.mediaType as string;
    const tmdbId = req.params.tmdbId as string;
    const season = req.query.season != null ? Number(req.query.season) : undefined;
    const episode = req.query.episode != null ? Number(req.query.episode) : undefined;
    const record = watchHistory.getProgress(mediaType, Number(tmdbId), season, episode);
    res.json({ record: record ?? null });
  });

  app.delete("/api/watch-history/:mediaType/:tmdbId", (req: Request, res: Response) => {
    const mediaType = req.params.mediaType as string;
    const tmdbId = Number(req.params.tmdbId as string);
    if (!VALID_MEDIA_TYPES.includes(mediaType) || isNaN(tmdbId)) {
      res.status(400).json({ error: "invalid_params" });
      return;
    }
    watchHistory.removeTitle(mediaType, tmdbId);
    res.json({ ok: true });
  });

  // ── Saved List ─────────────────────────────────────────────────────

  app.post("/api/saved/toggle", (req: Request, res: Response) => {
    const { tmdbId, mediaType, title, posterPath } = req.body;
    if (!tmdbId || !mediaType || !title) {
      res.status(400).json({ error: "missing_fields" });
      return;
    }
    if (!VALID_MEDIA_TYPES.includes(mediaType)) {
      res.status(400).json({ error: "invalid_media_type" });
      return;
    }
    const saved = savedList.toggle({
      tmdbId: Number(tmdbId),
      mediaType,
      title,
      posterPath: posterPath ?? null,
    });
    res.json({ saved });
  });

  app.get("/api/saved", (_req: Request, res: Response) => {
    res.json({ items: savedList.getAll() });
  });

  app.get("/api/saved/:mediaType/:tmdbId", (req: Request, res: Response) => {
    const mediaType = req.params.mediaType as string;
    const tmdbId = req.params.tmdbId as string;
    res.json({ saved: savedList.isSaved(mediaType, Number(tmdbId)) });
  });
}
