import crypto from "crypto";
import os from "os";
import type { Express, Request, Response } from "express";
import type { ServerContext, RCSession, RCClient } from "../lib/types.js";

export default function rcRoutes(app: Express, ctx: ServerContext): void {
  const { log, pcAuthToken, rcSessions } = ctx;

  function rcSession(id: string): RCSession | null {
    const s = rcSessions.get(id);
    if (s) s.lastActivity = Date.now();
    return s || null;
  }

  function sseWrite(res: RCClient, event: string, data: unknown): void {
    try {
      (res as unknown as Response).write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Connection already closed
    }
  }

  app.get("/api/auth/persist", (req: Request, res: Response) => {
    // Only reachable after nginx basic auth succeeded (or a valid token).
    // Set a long-lived cookie — nginx skips basic auth when rc_auth cookie exists.
    res.setHeader("Set-Cookie",
      `rc_auth=${pcAuthToken}; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`);
    res.json({ ok: true });
  });

  // Create session
  app.post("/api/rc/session", (req: Request, res: Response) => {
    const sessionId = crypto.randomBytes(4).toString("hex");
    const authToken = crypto.randomBytes(16).toString("hex");
    rcSessions.set(sessionId, {
      playerClient: null,
      remoteClients: [],
      playbackState: null,
      lastActivity: Date.now(),
      authToken,
    });
    log("info", "RC session created", { sessionId });
    res.json({ sessionId, authToken });
  });

  // LAN IP for phone remote pairing (native shell binds to 0.0.0.0 but QR needs a real IP)
  app.get("/api/rc/lan-ip", (_req: Request, res: Response) => {
    const interfaces = os.networkInterfaces();
    for (const addrs of Object.values(interfaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === "IPv4" && !addr.internal) {
          return res.json({ ip: addr.address, port: Number(process.env.PORT) || 3000 });
        }
      }
    }
    res.json({ ip: null, port: Number(process.env.PORT) || 3000 });
  });

  // Session status probe (used by phone to detect expired sessions)
  app.get("/api/rc/session/:sessionId", (req: Request, res: Response) => {
    const { sessionId } = req.params as Record<string, string>;
    const s = rcSessions.get(sessionId);
    if (!s) return res.status(404).json({ error: "session_expired" });
    s.lastActivity = Date.now();
    res.json({ exists: true, playerOnline: !!s.playerClient });
  });

  // Phone remote auth — validates token, sets cookie, redirects to /remote
  // This endpoint is exempt from nginx basic auth.
  // The cookie it sets (rc_auth) tells nginx to skip basic auth on all other requests.
  app.get("/api/rc/auth", (req: Request, res: Response) => {
    const { token, session } = req.query as { token?: string; session?: string };
    if (!token || !session) return res.status(400).send("Missing token or session");
    const s = rcSessions.get(session);
    if (!s || s.authToken !== token) return res.status(401).send("Invalid token");
    s.lastActivity = Date.now();
    // Set a long-lived cookie that nginx checks to skip basic auth
    res.setHeader("Set-Cookie", [
      `rc_auth=${token}; Path=/; Max-Age=${60 * 60 * 24}; SameSite=Lax`,
      `rc_token=${token}; Path=/; Max-Age=${60 * 60 * 24}; SameSite=Lax`,
    ]);
    res.redirect(`/remote?session=${session}`);
  });

  // Delete session
  app.delete("/api/rc/session/:sessionId", (req: Request, res: Response) => {
    const { sessionId } = req.params as Record<string, string>;
    const s = rcSessions.get(sessionId);
    if (!s) return res.status(404).json({ error: "session not found" });
    if (s.playerClient) s.playerClient.end();
    for (const c of s.remoteClients) c.end();
    rcSessions.delete(sessionId);
    log("info", "RC session deleted", { sessionId });
    res.json({ ok: true });
  });

  // SSE event stream
  app.get("/api/rc/events", (req: Request, res: Response) => {
    const { session, role } = req.query as { session?: string; role?: string };
    const s = rcSession(session || "");
    if (!s) return res.status(404).json({ error: "session not found" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const resAsClient = res as unknown as RCClient;

    if (role === "player") {
      s.playerClient = resAsClient;
      // Notify remotes that player connected
      for (const c of s.remoteClients) sseWrite(c, "connected", {});
      // Send current state if any (for reconnection)
      if (s.playbackState) sseWrite(resAsClient, "state", s.playbackState);
    } else {
      s.remoteClients.push(resAsClient);
      // Send player connection status
      sseWrite(resAsClient, s.playerClient ? "connected" : "disconnected", {});
      // Send current playback state
      if (s.playbackState) sseWrite(resAsClient, "state", s.playbackState);
      // Notify player that a remote connected
      if (s.playerClient) sseWrite(s.playerClient, "remote-connected", { count: s.remoteClients.length });
    }

    // Heartbeat every 30s
    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
    }, 30000);

    req.on("close", () => {
      clearInterval(heartbeat);
      if (role === "player") {
        if (s.playerClient === resAsClient) {
          s.playerClient = null;
          for (const c of s.remoteClients) sseWrite(c, "disconnected", {});
        }
      } else {
        s.remoteClients = s.remoteClients.filter((c) => c !== resAsClient);
        // Notify player that a remote disconnected
        if (s.playerClient) sseWrite(s.playerClient, "remote-disconnected", { count: s.remoteClients.length });
      }
    });
  });

  // Command (phone → PC)
  app.post("/api/rc/command", (req: Request, res: Response) => {
    const { sessionId, action, value } = req.body as { sessionId: string; action: string; value?: unknown };
    const s = rcSession(sessionId);
    if (!s) return res.status(404).json({ error: "session not found" });
    if (s.playerClient) {
      sseWrite(s.playerClient, "command", { action, value });
    }
    res.json({ ok: true });
  });

  // Phone requests player to show QR for reconnection
  // Broadcasts to ALL active player SSE connections (phone doesn't know which session is current)
  app.post("/api/rc/request-qr", (_req: Request, res: Response) => {
    for (const [, s] of rcSessions) {
      if (s.playerClient) sseWrite(s.playerClient, "show-qr", {});
    }
    res.json({ ok: true });
  });

  // State (PC → phone)
  app.post("/api/rc/state", (req: Request, res: Response) => {
    const { sessionId, ...state } = req.body as { sessionId: string; [key: string]: unknown };
    const s = rcSession(sessionId);
    if (!s) return res.status(404).json({ error: "session not found" });
    s.playbackState = state as RCSession["playbackState"];
    for (const c of s.remoteClients) sseWrite(c, "state", state);
    res.json({ ok: true });
  });
}
