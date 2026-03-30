import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../helpers/mock-app.js";

describe("RC routes", () => {
  let baseUrl: string, close: () => Promise<void>;

  before(async () => {
    ({ baseUrl, close } = await startTestServer());
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
      const createRes = await fetch(`${baseUrl}/api/rc/session`, { method: "POST" });
      const { sessionId } = await createRes.json() as { sessionId: string };

      const res = await fetch(`${baseUrl}/api/rc/session/${sessionId}`);
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
      const createRes = await fetch(`${baseUrl}/api/rc/session`, { method: "POST" });
      const { sessionId } = await createRes.json() as { sessionId: string };

      const delRes = await fetch(`${baseUrl}/api/rc/session/${sessionId}`, { method: "DELETE" });
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
      const createRes = await fetch(`${baseUrl}/api/rc/session`, { method: "POST" });
      const { sessionId } = await createRes.json() as { sessionId: string };

      const res = await fetch(`${baseUrl}/api/rc/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, action: "togglePlay" }),
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
      const createRes = await fetch(`${baseUrl}/api/rc/session`, { method: "POST" });
      const { sessionId } = await createRes.json() as { sessionId: string };

      const res = await fetch(`${baseUrl}/api/rc/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, playing: true, currentTime: 42 }),
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
      const createRes = await fetch(`${baseUrl}/api/rc/session`, { method: "POST" });
      const { sessionId } = await createRes.json() as { sessionId: string };

      const controller = new AbortController();
      const res = await fetch(
        `${baseUrl}/api/rc/events?session=${sessionId}&role=player`,
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
      const createRes = await fetch(`${baseUrl}/api/rc/session`, { method: "POST" });
      const { sessionId, authToken } = await createRes.json() as { sessionId: string; authToken: string };

      const res = await fetch(
        `${baseUrl}/api/rc/auth?token=${authToken}&session=${sessionId}`,
        { redirect: "manual" }
      );
      assert.equal(res.status, 302);
      const location = res.headers.get("location")!;
      assert.ok(location.includes(`/remote?session=${sessionId}`), "should redirect to /remote");
      const setCookie = res.headers.get("set-cookie")!;
      assert.ok(setCookie, "should set cookies");
      assert.ok(setCookie.includes("rc_auth="), "should set rc_auth cookie");
    });
  });
});
