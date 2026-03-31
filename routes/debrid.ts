import type { Express, Request, Response } from "express";
import type { ServerContext } from "../lib/types.js";
import {
  getDebridProvider, reloadDebridProvider,
  loadConfig, saveConfig, deleteConfig, configExists,
} from "../lib/debrid.js";

export default function debridRoutes(app: Express, ctx: ServerContext): void {
  const { log } = ctx;

  // Current debrid status
  app.get("/api/debrid/status", (_req: Request, res: Response) => {
    const cfg = loadConfig();
    res.json({
      configured: !!cfg,
      provider: cfg?.provider || null,
    });
  });

  // Save debrid config
  app.post("/api/debrid/config", async (req: Request, res: Response) => {
    const { apiKey, provider } = req.body as { apiKey?: string; provider?: string };
    if (!apiKey || !provider) {
      return res.status(400).json({ error: "apiKey and provider are required" });
    }
    if (provider !== "realdebrid") {
      return res.status(400).json({ error: "Unsupported provider. Supported: realdebrid" });
    }

    saveConfig(provider, apiKey);
    reloadDebridProvider();
    log("info", "Debrid config saved", { provider });
    res.json({ ok: true });
  });

  // Remove debrid config
  app.delete("/api/debrid/config", (_req: Request, res: Response) => {
    deleteConfig();
    reloadDebridProvider();
    log("info", "Debrid config removed");
    res.json({ ok: true });
  });

  // Validate API key with provider
  app.get("/api/debrid/verify", async (_req: Request, res: Response) => {
    const provider = getDebridProvider();
    if (!provider) {
      return res.json({ configured: false, valid: false, premium: false, expiration: null, username: null });
    }
    try {
      const result = await provider.validateKey();
      res.json({ configured: true, ...result });
    } catch (err) {
      log("warn", "Debrid verify failed", { error: (err as Error).message });
      res.json({ configured: true, valid: false, premium: false, expiration: null, username: null });
    }
  });

  // Check instant availability for a list of hashes
  app.post("/api/debrid/cached", async (req: Request, res: Response) => {
    const { infoHashes } = req.body as { infoHashes?: string[] };
    if (!infoHashes || !Array.isArray(infoHashes)) {
      return res.status(400).json({ error: "infoHashes array required" });
    }
    const provider = getDebridProvider();
    if (!provider) {
      return res.json({ cached: {} });
    }
    try {
      const result = await provider.checkCached(infoHashes);
      const cached: Record<string, boolean> = {};
      for (const [hash, isCached] of result) cached[hash] = isCached;
      res.json({ cached });
    } catch (err) {
      log("warn", "Debrid cache check failed", { error: (err as Error).message });
      res.json({ cached: {} });
    }
  });
}
