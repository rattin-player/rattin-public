import type { Express, Request, Response } from "express";
import type { ServerContext } from "../lib/types.js";
import { getStore } from "../lib/storage/learned-offsets.js";

export default function learnOffsetRoutes(app: Express, _ctx: ServerContext): void {
  app.post("/api/learn-offset", (req: Request, res: Response) => {
    const { tmdbId, type, offset_sec, season, episode } = (req.body ?? {}) as {
      tmdbId?: unknown;
      type?: unknown;
      offset_sec?: unknown;
      season?: unknown;
      episode?: unknown;
    };
    if (!tmdbId || typeof offset_sec !== "number" || type !== "outro") {
      return res.status(400).json({ error: "invalid payload" });
    }
    getStore().addOutroSample(String(tmdbId), {
      offset: offset_sec,
      at: new Date().toISOString(),
      season: Number(season) || 0,
      episode: Number(episode) || 0,
    });
    res.json({ ok: true });
  });

  app.get("/api/learn-offset/:tmdbId", (req: Request, res: Response) => {
    const result = getStore().getOutroOffset(String(req.params.tmdbId));
    res.json({
      outro_offset: result?.offset ?? null,
      sample_count: result?.sampleCount ?? 0,
    });
  });
}
