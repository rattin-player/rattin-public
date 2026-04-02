import type { Request, RequestHandler } from "express";
import type { RCSession, ServerContext } from "./types.js";

type CookieMap = Record<string, string>;

interface CookieOptions {
  httpOnly?: boolean;
}

interface RcAuthResult {
  sessionId: string;
  session: RCSession;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readCookieMap(req: Request): CookieMap {
  return ((req as Request & { cookies?: CookieMap }).cookies || {}) as CookieMap;
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return readString(value[0]);
  return readString(value);
}

function normalizeIp(ip: string | null): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

function requestPath(req: Request): string {
  return req.originalUrl.split("?")[0] || req.originalUrl;
}

export function buildCookie(name: string, value: string, maxAgeSeconds: number, options: CookieOptions = {}): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "SameSite=Lax",
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  return parts.join("; ");
}

export function clearCookie(name: string, options: CookieOptions = {}): string {
  return buildCookie(name, "", 0, options);
}

export function getRequestIp(req: Request): string | null {
  const socketIp = normalizeIp(req.socket.remoteAddress || null);
  const forwarded = firstHeaderValue(req.headers["x-forwarded-for"]);
  if ((socketIp === "127.0.0.1" || socketIp === "::1") && forwarded) {
    return normalizeIp(forwarded.split(",")[0]?.trim() || null);
  }
  return socketIp;
}

export function isLocalRequest(req: Request): boolean {
  const ip = getRequestIp(req);
  return ip === "127.0.0.1" || ip === "::1";
}

export function getRcSessionId(req: Request): string | null {
  const cookies = readCookieMap(req);
  const body = (req.body || {}) as { sessionId?: unknown };
  return readString(req.params?.sessionId)
    || readString(req.query?.session)
    || readString(body.sessionId)
    || readString(cookies.rc_session);
}

export function getRcAuthToken(req: Request): string | null {
  const cookies = readCookieMap(req);
  const body = (req.body || {}) as { authToken?: unknown; token?: unknown };
  const authHeader = firstHeaderValue(req.headers.authorization);
  return readString(req.query?.token)
    || readString(body.authToken)
    || readString(body.token)
    || firstHeaderValue(req.headers["x-rattin-rc-token"])
    || (authHeader?.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : authHeader)
    || readString(cookies.rc_token);
}

export function getAuthorizedRcSession(
  req: Request,
  rcSessions: Map<string, RCSession>,
  options: { touch?: boolean } = {},
): RcAuthResult | null {
  const sessionId = getRcSessionId(req);
  const token = getRcAuthToken(req);
  if (!sessionId || !token) return null;
  const session = rcSessions.get(sessionId);
  if (!session || !session.authToken || session.authToken !== token) return null;
  if (options.touch !== false) session.lastActivity = Date.now();
  return { sessionId, session };
}

function isRemoteSafeRoute(req: Request): boolean {
  const path = requestPath(req);
  const { method } = req;

  if (method === "GET" && path === "/api/rc/auth") return true;
  if (method === "GET" && path === "/api/tmdb/status") return true;
  if (method === "GET" && path.startsWith("/api/tmdb/")) return true;
  if (method === "GET" && path.startsWith("/api/reviews/")) return true;
  if (method === "POST" && path === "/api/check-availability") return true;
  if (method === "POST" && path === "/api/search-streams") return true;
  if (method === "POST" && path === "/api/auto-play") return true;
  if (method === "POST" && path === "/api/play-torrent") return true;
  if (method === "GET" && /^\/api\/rc\/session\/[^/]+$/.test(path)) return true;
  if (method === "DELETE" && /^\/api\/rc\/session\/[^/]+$/.test(path)) return true;
  if (method === "GET" && path === "/api/rc/events") return true;
  if (method === "POST" && path === "/api/rc/command") return true;
  if (method === "POST" && path === "/api/rc/request-qr") return true;

  return false;
}

export function createApiAccessControl(ctx: ServerContext): RequestHandler {
  return (req, res, next) => {
    if (isLocalRequest(req)) return next();

    if (requestPath(req) === "/api/rc/auth") return next();

    if (!getAuthorizedRcSession(req, ctx.rcSessions, { touch: false })) {
      return res.status(401).json({ error: "remote_auth_required" });
    }

    if (!isRemoteSafeRoute(req)) {
      return res.status(403).json({ error: "local_only" });
    }

    next();
  };
}
