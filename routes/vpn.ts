import { readFileSync, existsSync } from "fs";
import path from "path";
import type { Express, Request, Response } from "express";
import type { ServerContext } from "../lib/types.js";
import { configDir } from "../lib/storage/paths.js";

const CONFIG_DIR = configDir();
const STATE_FILE = path.join(CONFIG_DIR, "vpn-state.json");
const WG_CONF = path.join(CONFIG_DIR, "wg", "wg0.conf");

interface VpnState {
  active: boolean;
  configured: boolean;
}

const VPN_SUPPORTED = process.platform === "linux";

function readState(): VpnState {
  if (!VPN_SUPPORTED) {
    return { active: false, configured: false };
  }
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const state = JSON.parse(raw) as VpnState;
    return {
      active: Boolean(state.active),
      configured: existsSync(WG_CONF),
    };
  } catch {
    return { active: false, configured: existsSync(WG_CONF) };
  }
}

export default function vpnRoutes(app: Express, ctx: ServerContext): void {
  const { log } = ctx;

  // Current VPN status
  app.get("/api/vpn/status", (_req: Request, res: Response) => {
    const state = readState();
    res.json({
      active: state.active,
      configured: state.configured,
      supported: VPN_SUPPORTED,
    });
  });

  // Toggle VPN on/off — signals the supervisor via SIGUSR1
  app.post("/api/vpn/toggle", async (req: Request, res: Response) => {
    const { action } = req.body as { action?: "on" | "off" };
    if (action !== "on" && action !== "off") {
      return res.status(400).json({ error: "action must be 'on' or 'off'" });
    }

    if (!VPN_SUPPORTED) {
      return res.status(501).json({ error: "VPN routing is only available on Linux" });
    }

    const state = readState();
    if (!state.configured) {
      return res.status(400).json({ error: `No WireGuard config found. Place wg0.conf in ${path.join(CONFIG_DIR, "wg")}/` });
    }

    if ((action === "on" && state.active) || (action === "off" && !state.active)) {
      return res.json({ status: "no_change", active: state.active });
    }

    // Signal supervisor to toggle — supervisor sends SIGTERM to Node first,
    // which triggers the cleanup handler in server.ts (dumps sessions)
    const ppid = process.ppid;
    if (ppid && ppid > 1) {
      try {
        process.kill(ppid, "SIGUSR1");
        log("info", `VPN toggle ${action} — signaled supervisor (PID ${ppid})`);
        res.json({ status: "restarting", expectedDowntime: 3000 });
      } catch (err) {
        log("err", "Failed to signal supervisor", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to signal supervisor. Is rattin-vpn running?" });
      }
    } else {
      log("warn", "No supervisor detected (ppid=1). VPN toggle requires the rattin-vpn supervisor.");
      res.status(400).json({ error: "VPN toggle requires the rattin-vpn supervisor. Start with ./rattin-vpn instead of node server.ts" });
    }
  });

  // Verify external IP to confirm VPN is working
  app.get("/api/vpn/verify", async (_req: Request, res: Response) => {
    try {
      const ipRes = await fetch("https://api.ipify.org?format=json");
      const { ip } = await ipRes.json() as { ip: string };
      const state = readState();
      res.json({ ip, vpnActive: state.active });
    } catch (err) {
      log("warn", "VPN verify failed", { error: (err as Error).message });
      res.status(500).json({ error: "Could not determine external IP" });
    }
  });
}
