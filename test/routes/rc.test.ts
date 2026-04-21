import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../helpers/mock-app.js";
import type { RCSession } from "../../lib/types.js";

describe("RC routes", () => {
  let baseUrl: string, close: () => Promise<void>;
  let rcSessions: Map<string, RCSession>;

  async function createSession(): Promise<{ sessionId: string; authToken: string }> {
    const res = await fetch(`${baseUrl}/api/rc/session`, { method: "POST" });
    return res.json() as Promise<{ sessionId: string; authToken: string }>;
  }

  before(async () => {
    const server = await startTestServer();
    baseUrl = server.baseUrl;
    close = server.close;
    rcSessions = server.rcSessions;
  });

  after(async () => {
    await close();
  });

  // ── POST /api/rc/session ──────────────────────────────────────────────

  describe("POST /api/rc/session", () => {
    it("creates a session and returns sessionId + authToken", async () => {
      const res = await fetch(`${baseUrl}/api/rc/session`, { method: "POST" });
      assert.equal(res.status, 200);
      const body = await res.json() as { sessionId: string; authToken: string };
      assert.ok(body.sessionId, "should have sessionId");
      assert.ok(body.authToken, "should have authToken");
      assert.equal(typeof body.sessionId, "string");
      assert.equal(typeof body.authToken, "string");
    });
  });

  // ── GET /api/rc/session/:id ───────────────────────────────────────────

  describe("GET /api/rc/session/:id", () => {
    it("returns 404 for non-existent session", async () => {
      const res = await fetch(`${baseUrl}/api/rc/session/nonexistent`);
      assert.equal(res.status, 404);
      const body = await res.json() as { error: string };
      assert.equal(body.error, "session_expired");
    });

    it("returns 200 for a valid session", async () => {
      const { sessionId, authToken } = await createSession();

      const res = await fetch(`${baseUrl}/api/rc/session/${sessionId}?token=${authToken}`);
      assert.equal(res.status, 200);
      const body = await res.json() as { exists: boolean; playerOnline: boolean };
      assert.equal(body.exists, true);
      assert.equal(body.playerOnline, false);
    });
  });

  // ── DELETE /api/rc/session/:id ────────────────────────────────────────

  describe("DELETE /api/rc/session/:id", () => {
    it("returns 404 for non-existent session", async () => {
      const res = await fetch(`${baseUrl}/api/rc/session/nonexistent`, { method: "DELETE" });
      assert.equal(res.status, 404);
    });

    it("deletes an existing session", async () => {
      const { sessionId, authToken } = await createSession();

      const delRes = await fetch(`${baseUrl}/api/rc/session/${sessionId}?token=${authToken}`, { method: "DELETE" });
      assert.equal(delRes.status, 200);
      const body = await delRes.json() as { ok: boolean };
      assert.equal(body.ok, true);

      // Verify it's gone
      const getRes = await fetch(`${baseUrl}/api/rc/session/${sessionId}`);
      assert.equal(getRes.status, 404);
    });
  });

  // ── POST /api/rc/command ──────────────────────────────────────────────

  describe("POST /api/rc/command", () => {
    it("returns 404 for bad session", async () => {
      const res = await fetch(`${baseUrl}/api/rc/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "bad", action: "play" }),
      });
      assert.equal(res.status, 404);
    });

    it("returns 200 for valid session", async () => {
      const { sessionId, authToken } = await createSession();

      const res = await fetch(`${baseUrl}/api/rc/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, authToken, action: "togglePlay" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { ok: boolean };
      assert.equal(body.ok, true);
    });
  });

  // ── POST /api/rc/state ────────────────────────────────────────────────

  describe("POST /api/rc/state", () => {
    it("returns 404 for bad session", async () => {
      const res = await fetch(`${baseUrl}/api/rc/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "bad", playing: true }),
      });
      assert.equal(res.status, 404);
    });

    it("returns 200 for valid session", async () => {
      const { sessionId, authToken } = await createSession();

      const res = await fetch(`${baseUrl}/api/rc/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, authToken, playing: true, currentTime: 42 }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { ok: boolean };
      assert.equal(body.ok, true);
    });
  });

  // ── GET /api/rc/events ────────────────────────────────────────────────

  describe("GET /api/rc/events", () => {
    it("returns 404 for bad session", async () => {
      const res = await fetch(`${baseUrl}/api/rc/events?session=bad&role=player`);
      assert.equal(res.status, 404);
    });

    it("returns SSE stream with correct content-type for valid session", async () => {
      const { sessionId, authToken } = await createSession();

      const controller = new AbortController();
      const res = await fetch(
        `${baseUrl}/api/rc/events?session=${sessionId}&role=player&token=${authToken}`,
        { signal: controller.signal }
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/event-stream");
      assert.equal(res.headers.get("cache-control"), "no-cache");

      // Abort the SSE connection after verifying headers
      controller.abort();
    });
  });

  // ── GET /api/rc/auth ──────────────────────────────────────────────────

  describe("GET /api/rc/auth", () => {
    it("returns 400 when token or session is missing", async () => {
      const res = await fetch(`${baseUrl}/api/rc/auth`);
      assert.equal(res.status, 400);

      const res2 = await fetch(`${baseUrl}/api/rc/auth?token=abc`);
      assert.equal(res2.status, 400);

      const res3 = await fetch(`${baseUrl}/api/rc/auth?session=abc`);
      assert.equal(res3.status, 400);
    });

    it("returns 401 for invalid token", async () => {
      const createRes = await fetch(`${baseUrl}/api/rc/session`, { method: "POST" });
      const { sessionId } = await createRes.json() as { sessionId: string };

      const res = await fetch(
        `${baseUrl}/api/rc/auth?token=wrongtoken&session=${sessionId}`,
        { redirect: "manual" }
      );
      assert.equal(res.status, 401);
    });

    it("returns 302 redirect with valid token", async () => {
      const { sessionId, authToken } = await createSession();

      const res = await fetch(
        `${baseUrl}/api/rc/auth?token=${authToken}&session=${sessionId}`,
        { redirect: "manual" }
      );
      assert.equal(res.status, 302);
      const location = res.headers.get("location")!;
      assert.equal(location, "/remote");
      const setCookie = res.headers.get("set-cookie")!;
      assert.ok(setCookie, "should set cookies");
      assert.ok(setCookie.includes("rc_auth="), "should set rc_auth cookie");
    });
  });

  // ── set-binge-mode command ────────────────────────────────────────────

  describe("set-binge-mode command", () => {
    it("toggles bingeMode.enabled on the session and broadcasts", async () => {
      const { sessionId, authToken } = await createSession();

      const res = await fetch(`${baseUrl}/api/rc/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, authToken, action: "set-binge-mode", value: { enabled: true } }),
      });

      assert.equal(res.status, 200);
      assert.equal(rcSessions.get(sessionId)!.bingeMode.enabled, true);
    });

    it("clears capabilities when disabling", async () => {
      const { sessionId, authToken } = await createSession();
      const session = rcSessions.get(sessionId)!;
      session.bingeMode.enabled = true;
      session.bingeMode.capabilities = {
        autoSkipIntro: { enabled: true, source: "chapter markers" },
        autoSkipCredits: { enabled: true, source: "chapter markers" },
        persistTracks: { enabled: true },
        autoAdvance: { enabled: true, viaEOF: false },
        prefetch: { enabled: true, via: "debrid cache" },
      };

      const res = await fetch(`${baseUrl}/api/rc/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, authToken, action: "set-binge-mode", value: { enabled: false } }),
      });

      assert.equal(res.status, 200);
      assert.equal(session.bingeMode.enabled, false);
      assert.equal(session.bingeMode.capabilities, null);
    });

    it("rejects set-binge-mode with non-boolean payload", async () => {
      const { sessionId, authToken } = await createSession();

      const res = await fetch(`${baseUrl}/api/rc/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, authToken, action: "set-binge-mode", value: { enabled: "yes" } }),
      });

      assert.equal(res.status, 400);
    });
  });
});
