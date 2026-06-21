import type { Express, Request, Response } from "express";
import type { ServerContext } from "../lib/types.js";
import { dirSize, clearDir, formatBytes } from "../lib/cache/cache-cleanup.js";

export default function cacheRoutes(app: Express, ctx: ServerContext): void {
  const { log } = ctx;
  // Access ctx.client and DOWNLOAD_PATH via getters so deferred init and
  // settings changes are visible at request time.
  const client = () => ctx.client;

  app.get("/api/cache/size", async (_req: Request, res: Response) => {
    const bytes = await dirSize(ctx.DOWNLOAD_PATH);
    res.json({ bytes, formatted: formatBytes(bytes) });
  });

  app.delete("/api/cache", async (_req: Request, res: Response) => {
    log("info", "Manual cache clear requested");

    // Destroy all active torrents first — they hold file handles that prevent
    // deletion on Windows (EBUSY) and cause silent failures.
    const torrents = [...client().torrents];
    for (const torrent of torrents) {
      try {
        torrent.destroy({ destroyStore: false });
        log("info", "Destroyed torrent for cache clear", { name: torrent.name });
      } catch (err) {
        log("warn", "Failed to destroy torrent", { name: torrent.name, error: (err as Error).message });
      }
    }

    // Clear the download directory
    await clearDir(ctx.DOWNLOAD_PATH);

    // Verify the directory is actually empty — report any remaining files
    const remaining = await dirSize(ctx.DOWNLOAD_PATH);
    if (remaining > 0) {
      log("warn", "Cache clear incomplete — some files remain", { remaining: formatBytes(remaining) });
      res.json({ cleared: false, remaining: formatBytes(remaining) });
    } else {
      res.json({ cleared: true });
    }
  });

  // Native folder picker — opens a platform-specific directory chooser dialog
  app.post("/api/browse-folder", async (_req: Request, res: Response) => {
    const { spawn } = await import("node:child_process");
    const isWin = process.platform === "win32";

    const cmd = isWin
      ? "powershell"
      : "zenity";
    const args = isWin
      ? ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select download folder'; $f.ShowNewFolderButton = $true; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }"]
      : ["--file-selection", "--directory", "--title=Select download folder"];

    try {
      const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.on("close", (code: number) => {
        const selected = stdout.trim();
        if (code === 0 && selected) {
          res.json({ path: selected });
        } else {
          res.json({ path: null, error: stderr.trim() || "No folder selected" });
        }
      });

      // Timeout after 60 seconds (user might take a while to pick)
      setTimeout(() => {
        try { proc.kill(); } catch {}
        res.json({ path: null, error: "Dialog timed out" });
      }, 60000);
    } catch (err) {
      res.json({ path: null, error: (err as Error).message });
    }
  });
}
