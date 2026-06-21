// routes/plugins.ts
import type { Express, Request, Response } from "express";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { ServerContext } from "../lib/types.js";
import type { PluginIndexEntry } from "../lib/plugins/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CDN_INDEX_URL = "https://rattin-plugins.pages.dev/plugin-index.json";
const LOCAL_INDEX_PATH = path.join(__dirname, "..", "public", "plugin-index.json");

async function fetchPluginIndex(): Promise<PluginIndexEntry[]> {
  // Try the live CDN index first
  try {
    const resp = await fetch(CDN_INDEX_URL, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) return await resp.json() as PluginIndexEntry[];
  } catch { /* CDN unreachable — fall back to local */ }
  // Fall back to the local bootstrap index
  try {
    return JSON.parse(readFileSync(LOCAL_INDEX_PATH, "utf8")) as PluginIndexEntry[];
  } catch {
    return [];
  }
}

export default function pluginRoutes(app: Express, ctx: ServerContext): void {
  const { log, pluginRegistry } = ctx;

  if (!pluginRegistry) {
    log("warn", "Plugin routes registered but no pluginRegistry in context");
    return;
  }

  // GET /api/plugins/status — current install/run status
  app.get("/api/plugins/status", (_req: Request, res: Response) => {
    res.json(pluginRegistry.getStatus());
  });

  // GET /api/plugins/index — fetch the live plugin index from CDN (fallback to local)
  app.get("/api/plugins/index", async (_req: Request, res: Response) => {
    try {
      const index = await fetchPluginIndex();
      res.json(index);
    } catch (err) {
      log("err", "Failed to fetch plugin index", { error: (err as Error).message });
      res.json([]);
    }
  });

  // POST /api/plugins/install — download from URL, verify, save, spawn
  app.post("/api/plugins/install", async (req: Request, res: Response) => {
    const { url, entry } = req.body as { url?: string; entry?: PluginIndexEntry };
    if (!url || !entry) {
      return res.status(400).json({ error: "url and entry are required" });
    }
    try {
      await pluginRegistry.installFromUrl(url, entry);
      log("info", "Plugin installed", { url, version: entry.version });
      res.json(pluginRegistry.getStatus());
    } catch (err) {
      log("err", "Plugin install failed", { error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/plugins/install-url — simple URL install (auto-detect metadata from /health)
  app.post("/api/plugins/install-url", async (req: Request, res: Response) => {
    const { url } = req.body as { url?: string };
    if (!url) {
      return res.status(400).json({ error: "url is required" });
    }
    try {
      await pluginRegistry.installFromUrlSimple(url);
      log("info", "Plugin installed from URL", { url });
      res.json(pluginRegistry.getStatus());
    } catch (err) {
      log("err", "Plugin install failed", { error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/plugins/reload — kill and respawn
  app.post("/api/plugins/reload", async (_req: Request, res: Response) => {
    try {
      await pluginRegistry.reload();
      res.json(pluginRegistry.getStatus());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/plugins — kill process, remove file
  app.delete("/api/plugins", async (_req: Request, res: Response) => {
    try {
      await pluginRegistry.uninstall();
      res.json(pluginRegistry.getStatus());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
