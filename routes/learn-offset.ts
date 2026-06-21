import type { Express, Request, Response } from "express";
import type { ServerContext } from "../lib/types.js";
import { getStore } from "../lib/storage/learned-offsets.js";

const isScalarId = (v: unknown): v is string | number =>
  (typeof v === "string" && v.length > 0) || (typeof v === "number" && Number.isFinite(v));

export default function learnOffsetRoutes(app: Express, _ctx: ServerContext): void {
  app.post("/api/learn-offset", (req: Request, res: Response) => {
    const { tmdbId, type, offset_sec, season, episode } = (req.body ?? {}) as {
      tmdbId?: unknown;
      type?: unknown;
      offset_sec?: unknown;
      season?: unknown;
      episode?: unknown;
    };
    if (!isScalarId(tmdbId) || type !== "outro" || typeof offset_sec !== "number" || !Number.isFinite(offset_sec) || offset_sec < 0) {
      return res.status(400).json({ error: "invalid payload" });
    }
    const seasonNum = typeof season === "number" && Number.isFinite(season) ? season : 0;
    const episodeNum = typeof episode === "number" && Number.isFinite(episode) ? episode : 0;
    getStore().addOutroSample(String(tmdbId), {
      offset: offset_sec,
      at: new Date().toISOString(),
      season: seasonNum,
      episode: episodeNum,
    });
    res.json({ ok: true });
  });

  app.get("/api/learn-offset/:tmdbId", (req: Request, res: Response) => {
    if (!isScalarId(req.params.tmdbId)) {
      return res.status(400).json({ error: "invalid tmdbId" });
    }
    const result = getStore().getOutroOffset(String(req.params.tmdbId));
    res.json({
      outro_offset: result?.offset ?? null,
      sample_count: result?.sampleCount ?? 0,
    });
  });
}
