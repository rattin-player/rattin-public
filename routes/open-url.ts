import { exec } from "child_process";
import type { Express, Request, Response } from "express";
import type { ServerContext } from "../lib/types.js";

export default function openUrlRoutes(app: Express, _ctx: ServerContext): void {
  app.post("/api/open-url", (req: Request, res: Response) => {
    const { url } = req.body as { url?: string };

    if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      res.status(400).json({ error: "Invalid URL — only http/https allowed" });
      return;
    }

    // Use the platform's default browser
    const cmd = process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";

    exec(`${cmd} ${JSON.stringify(url)}`, (err) => {
      if (err) console.error("[open-url] Failed to open:", err.message);
    });

    res.json({ ok: true });
  });
}
