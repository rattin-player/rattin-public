import crypto from "crypto";
import dgram from "dgram";
import os from "os";
import type { Express, Request, Response } from "express";
import { buildCookie, clearCookie, getRcAuthToken, getRcSessionId } from "../lib/access-control.js";
import type { ServerContext, RCSession, RCClient, BingeCapabilities, BingeDiagnostics, PersistedTracks } from "../lib/types.js";
import { dumpRcSessions } from "../lib/storage/rc-sessions.js";

/** Get the LAN IP the kernel would use to reach the internet.
 *  Works by connecting a UDP socket to a public address (no packets sent)
 *  and reading the locally bound address — the kernel picks the correct
 *  interface based on the routing table. VirtualBox/Docker host-only
 *  adapters never carry default routes, so they are never returned. */
function getLanIp(): Promise<string> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let resolved = false;
    const done = (addr: string) => {
      if (resolved) return;
      resolved = true;
      try { sock.close(); } catch {}
      resolve(addr);
    };
    sock.on("error", () => done(""));
    sock.connect(80, "1.1.1.1", () => {
      const addr = sock.address();
      done(addr && typeof addr === "object" ? addr.address : "");
    });
    setTimeout(() => done(""), 2000);
  });
}

export default function rcRoutes(app: Express, ctx: ServerContext): void {
  const { log, pcAuthToken, rcSessions } = ctx;

  function authorizeSession(
    req: Request,
    res: Response,
    options: { notFoundError: string },
  ): { sessionId: string; session: RCSession } | null {
    const sessionId = getRcSessionId(req);
    if (!sessionId) {
      res.status(400).json({ error: "sessionId required" });
      return null;
    }

    const session = rcSessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: options.notFoundError });
      return null;
    }

    const token = getRcAuthToken(req);
    if (!token || !session.authToken || session.authToken !== token) {
      res.status(401).json({ error: "invalid_token" });
      return null;
    }

    session.lastActivity = Date.now();
    return { sessionId, session };
  }

  function sseWrite(res: RCClient, event: string, data: unknown): void {
    try {
      (res as unknown as Response).write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Connection already closed
    }
  }

  function broadcastBinge(session: RCSession): void {
    for (const c of session.remoteClients) sseWrite(c, "binge", session.bingeMode);
    if (session.playerClient) sseWrite(session.playerClient, "binge", session.bingeMode);
  }

  function isCapabilityFlag(v: unknown, extra?: (obj: Record<string, unknown>) => boolean): boolean {
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    if (typeof o.enabled !== "boolean") return false;
    return extra ? extra(o) : true;
  }

  function isValidCapabilities(v: unknown): v is BingeCapabilities {
    if (!v || typeof v !== "object") return false;
    const c = v as Record<string, unknown>;
    return isCapabilityFlag(c.autoSkipIntro, (o) => typeof o.source === "string")
      && isCapabilityFlag(c.autoSkipCredits, (o) =>
           typeof o.source === "string"
           && (o.sampleCount === undefined || typeof o.sampleCount === "number"))
      && isCapabilityFlag(c.persistTracks)
      && isCapabilityFlag(c.autoAdvance, (o) => typeof o.viaEOF === "boolean")
      && isCapabilityFlag(c.prefetch, (o) =>
           o.via === null || typeof o.via === "string");
  }

  app.get("/api/auth/persist", (req: Request, res: Response) => {
    // Only reachable after nginx basic auth succeeded (or a valid token).
    // Set a long-lived cookie — nginx skips basic auth when rc_auth cookie exists.
    res.setHeader("Set-Cookie", buildCookie("rc_auth", pcAuthToken, 10 * 365 * 24 * 60 * 60, { httpOnly: true }));
    res.json({ ok: true });
  });

  // Create session (cleans up any previous sessions — one active pairing at a time)
  app.post("/api/rc/session", (req: Request, res: Response) => {
    // Tear down all existing sessions
    for (const [oldId, oldSession] of rcSessions) {
      if (oldSession.playerClient) oldSession.playerClient.end();
      for (const c of oldSession.remoteClients) c.end();
      rcSessions.delete(oldId);
    }
    const sessionId = crypto.randomBytes(16).toString("hex");
    const authToken = crypto.randomBytes(16).toString("hex");
    const pairingCode = String(crypto.randomInt(10000)).padStart(4, "0");
    rcSessions.set(sessionId, {
      playerClient: null,
      remoteClients: [],
      playbackState: null,
      lastActivity: Date.now(),
      authToken,
      pairingCode,
      bingeMode: { enabled: false, capabilities: null, persistedTracks: { audio: null, subtitles: null }, diagnostics: null },
    });
    log("info", "RC session created", { sessionId, pairingCode });
    dumpRcSessions(rcSessions);
    res.json({ sessionId, authToken, pairingCode });
  });

  // Active RC session (desktop reclaims its session after restart)
  // Returns the most recently active session so the frontend can reconnect.
  app.get("/api/rc/active-session", (_req: Request, res: Response) => {
    let best: { sessionId: string; authToken: string; pairingCode?: string; lastActivity: number } | null = null;
    for (const [sessionId, s] of rcSessions) {
      if (s.authToken && (!best || s.lastActivity > best.lastActivity)) {
        best = { sessionId, authToken: s.authToken, pairingCode: s.pairingCode, lastActivity: s.lastActivity };
      }
    }
    if (best) {
      res.json({ sessionId: best.sessionId, authToken: best.authToken, pairingCode: best.pairingCode });
    } else {
      res.json({ sessionId: null, authToken: null });
    }
  });

  // LAN IP for phone remote pairing — uses kernel routing table so virtual
  // adapters (VirtualBox, Docker, VPNs) are never picked up. Falls back to
  // interface iteration if the machine is offline.
  app.get("/api/rc/lan-ip", async (_req: Request, res: Response) => {
    const port = Number(process.env.PORT) || 3000;
    let ip = await getLanIp();

    // Fallback: offline/no default route — iterate interfaces.
    if (!ip) {
      const ifaces = os.networkInterfaces();
      outer:
      for (const [name, addrs] of Object.entries(ifaces)) {
        if (!addrs) continue;
        // Skip known virtual/host-only adapters (cross-platform)
        if (/^(vboxnet|vmnet|docker|virbr|tun|tap|veth|br-|utun|llw|awdl|anpi|bridge|lo$)/i.test(name)) continue;
        if (/(VirtualBox|vEthernet|Hyper-V|VMware|WSL)/i.test(name)) continue;
        for (const addr of addrs) {
          if (addr.family === "IPv4" && !addr.internal) {
            ip = addr.address;
            break outer;
          }
        }
      }
    }

    res.json({ ip: ip || null, port });
  });

  // Session status probe (used by phone to detect expired sessions)
  app.get("/api/rc/session/:sessionId", (req: Request, res: Response) => {
    const auth = authorizeSession(req, res, { notFoundError: "session_expired" });
    if (!auth) return;
    res.json({ exists: true, playerOnline: !!auth.session.playerClient });
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
      buildCookie("rc_auth", token, 10 * 365 * 24 * 60 * 60, { httpOnly: true }),
      buildCookie("rc_token", token, 10 * 365 * 24 * 60 * 60, { httpOnly: true }),
      buildCookie("rc_session", session, 10 * 365 * 24 * 60 * 60),
    ]);
    res.redirect("/remote");
  });

  // Pair via 4-digit code (alternative to QR scan — works without camera/HTTPS)
  app.post("/api/rc/pair", (req: Request, res: Response) => {
    const { code } = req.body as { code?: string };
    if (!code) return res.status(400).json({ error: "code required" });
    const normalized = code.trim();

    // Find the session with the matching pairing code
    let matchId: string | null = null;
    let matchSession: RCSession | null = null;
    for (const [sessionId, s] of rcSessions) {
      if (s.pairingCode && s.pairingCode === normalized) {
        matchId = sessionId;
        matchSession = s;
        break;
      }
    }
    if (!matchId || !matchSession || !matchSession.authToken) {
      return res.status(401).json({ error: "invalid_code" });
    }
    matchSession.lastActivity = Date.now();
    res.setHeader("Set-Cookie", [
      buildCookie("rc_auth", matchSession.authToken, 10 * 365 * 24 * 60 * 60, { httpOnly: true }),
      buildCookie("rc_token", matchSession.authToken, 10 * 365 * 24 * 60 * 60, { httpOnly: true }),
      buildCookie("rc_session", matchId, 10 * 365 * 24 * 60 * 60),
    ]);
    res.json({ ok: true });
  });

  // Delete session
  app.delete("/api/rc/session/:sessionId", (req: Request, res: Response) => {
    const auth = authorizeSession(req, res, { notFoundError: "session not found" });
    if (!auth) return;
    if (auth.session.playerClient) auth.session.playerClient.end();
    for (const c of auth.session.remoteClients) c.end();
    rcSessions.delete(auth.sessionId);
    log("info", "RC session deleted", { sessionId: auth.sessionId });
    dumpRcSessions(rcSessions);
    res.setHeader("Set-Cookie", [
      clearCookie("rc_auth", { httpOnly: true }),
      clearCookie("rc_token", { httpOnly: true }),
      clearCookie("rc_session"),
    ]);
    res.json({ ok: true });
  });

  // SSE event stream
  app.get("/api/rc/events", (req: Request, res: Response) => {
    const { role } = req.query as { role?: string };
    const auth = authorizeSession(req, res, { notFoundError: "session not found" });
    if (!auth) return;
    const s = auth.session;

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

    // Replay current binge-mode state so a reconnecting client doesn't
    // fall back to the default "disabled" until the next broadcast.
    sseWrite(resAsClient, "binge", s.bingeMode);

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
    const { action, value } = req.body as { action: string; value?: unknown };
    const auth = authorizeSession(req, res, { notFoundError: "session not found" });
    if (!auth) return;
    if (action === "set-binge-mode") {
      const enabled = (value as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be boolean" });
      }
      auth.session.bingeMode.enabled = enabled;
      if (!enabled) auth.session.bingeMode.capabilities = null;
      broadcastBinge(auth.session);
      return res.json({ ok: true });
    }
    if (action === "set-binge-capabilities") {
      const caps = (value as { capabilities?: unknown } | undefined)?.capabilities;
      if (caps !== null && caps !== undefined && !isValidCapabilities(caps)) {
        return res.status(400).json({ error: "invalid capabilities shape" });
      }
      auth.session.bingeMode.capabilities = (caps ?? null) as BingeCapabilities | null;
      broadcastBinge(auth.session);
      return res.json({ ok: true });
    }
    if (action === "set-persisted-tracks") {
      const tracks = (value as { tracks?: unknown } | undefined)?.tracks;
      if (!tracks || typeof tracks !== "object") {
        return res.status(400).json({ error: "tracks required" });
      }
      auth.session.bingeMode.persistedTracks = tracks as PersistedTracks;
      broadcastBinge(auth.session);
      return res.json({ ok: true });
    }
    if (action === "set-binge-diagnostics") {
      const diag = (value as { diagnostics?: unknown } | undefined)?.diagnostics;
      auth.session.bingeMode.diagnostics = (diag ?? null) as BingeDiagnostics | null;
      broadcastBinge(auth.session);
      return res.json({ ok: true });
    }
    if (auth.session.playerClient) {
      sseWrite(auth.session.playerClient, "command", { action, value });
    }
    res.json({ ok: true });
  });

  // Phone requests the paired player to show its QR again.
  app.post("/api/rc/request-qr", (req: Request, res: Response) => {
    const auth = authorizeSession(req, res, { notFoundError: "session not found" });
    if (!auth) return;
    if (auth.session.playerClient) sseWrite(auth.session.playerClient, "show-qr", {});
    res.json({ ok: true });
  });

  // State (PC → phone)
  app.post("/api/rc/state", (req: Request, res: Response) => {
    const { sessionId: _sessionId, authToken: _authToken, ...state } = req.body as {
      sessionId: string;
      authToken?: string;
      [key: string]: unknown;
    };
    const auth = authorizeSession(req, res, { notFoundError: "session not found" });
    if (!auth) return;
    auth.session.playbackState = state as RCSession["playbackState"];
    for (const c of auth.session.remoteClients) sseWrite(c, "state", state);
    res.json({ ok: true });
  });
}
