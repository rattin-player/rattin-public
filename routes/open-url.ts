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
    // Windows: "start" needs empty title ("") and windowsHide to suppress cmd flash
    const quoted = JSON.stringify(url);
    const cmd = process.platform === "darwin"
      ? `open ${quoted}`
      : process.platform === "win32"
        ? `start "" ${quoted}`
        : `xdg-open ${quoted}`;

    exec(cmd, { windowsHide: true }, (err) => {
      if (err) console.error("[open-url] Failed to open:", err.message);
    });

    res.json({ ok: true });
  });
}
