import type { Express, Request, Response } from "express";
import type { ServerContext } from "../lib/types.js";
import { getSettings, updateSettings } from "../lib/storage/settings.js";

export default function settingsRoutes(app: Express, _ctx: ServerContext): void {
  // GET /api/settings — returns current settings
  app.get("/api/settings", (_req: Request, res: Response) => {
    res.json(getSettings());
  });

  // PUT /api/settings — partial update (currently supports downloadPath)
  app.put("/api/settings", (req: Request, res: Response) => {
    const { downloadPath } = req.body as { downloadPath?: string };
    const patch: Record<string, string | undefined> = {};

    if (downloadPath !== undefined) {
      // Normalize: trim, remove trailing slashes
      const normalized = downloadPath.trim().replace(/[/\\]+$/, "");
      if (!normalized) {
        return res.status(400).json({ error: "downloadPath cannot be empty" });
      }
      patch.downloadPath = normalized;
    }

    const updated = updateSettings(patch);
    res.json(updated);
  });
}
