import type { Express, Request, Response } from "express";
import type { ServerContext } from "../lib/types.js";
import { dirSize, clearDir, formatBytes } from "../lib/cache/cache-cleanup.js";

export default function cacheRoutes(app: Express, ctx: ServerContext): void {
  const { DOWNLOAD_PATH, log } = ctx;

  app.get("/api/cache/size", async (_req: Request, res: Response) => {
    const bytes = await dirSize(DOWNLOAD_PATH);
    res.json({ bytes, formatted: formatBytes(bytes) });
  });

  app.delete("/api/cache", async (_req: Request, res: Response) => {
    log("info", "Manual cache clear requested");
    await clearDir(DOWNLOAD_PATH);
    res.json({ cleared: true });
  });
}
