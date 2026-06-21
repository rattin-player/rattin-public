import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../helpers/mock-app.js";

describe("Debrid routes", () => {
  let baseUrl: string, close: () => Promise<void>;

  before(async () => {
    ({ baseUrl, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  // ── GET /api/debrid/status ──────────────────────────────────────────

  describe("GET /api/debrid/status", () => {
    it("returns configured: false when no config exists", async () => {
      const res = await fetch(`${baseUrl}/api/debrid/status`);
      assert.equal(res.status, 200);
      const body = await res.json() as { configured: boolean; provider: string | null };
      assert.equal(body.configured, false);
      assert.equal(body.provider, null);
    });
  });

  // ── POST /api/debrid/config ─────────────────────────────────────────

  describe("POST /api/debrid/config", () => {
    it("returns 400 when apiKey is missing", async () => {
      const res = await fetch(`${baseUrl}/api/debrid/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "realdebrid" }),
      });
      assert.equal(res.status, 400);
    });

    it("returns 400 when provider is missing", async () => {
      const res = await fetch(`${baseUrl}/api/debrid/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "test123" }),
      });
      assert.equal(res.status, 400);
    });

    it("returns 400 for unsupported provider", async () => {
      const res = await fetch(`${baseUrl}/api/debrid/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "test123", provider: "unsupported" }),
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.ok(body.error.includes("Unsupported"));
    });

    it("saves config for valid request", async () => {
      const res = await fetch(`${baseUrl}/api/debrid/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "fake-key", provider: "realdebrid" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { ok: boolean };
      assert.equal(body.ok, true);

      // Verify status now shows configured
      const status = await fetch(`${baseUrl}/api/debrid/status`);
      const statusBody = await status.json() as { configured: boolean; provider: string };
      assert.equal(statusBody.configured, true);
      assert.equal(statusBody.provider, "realdebrid");
    });

    it("saves config for torbox provider", async () => {
      const res = await fetch(`${baseUrl}/api/debrid/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "tb-key", provider: "torbox" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { ok: boolean };
      assert.equal(body.ok, true);

      const status = await fetch(`${baseUrl}/api/debrid/status`);
      const statusBody = await status.json() as { configured: boolean; provider: string };
      assert.equal(statusBody.configured, true);
      assert.equal(statusBody.provider, "torbox");
    });
  });

  // ── DELETE /api/debrid/config ───────────────────────────────────────

  describe("DELETE /api/debrid/config", () => {
    it("removes config", async () => {
      // First save one
      await fetch(`${baseUrl}/api/debrid/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "to-delete", provider: "realdebrid" }),
      });

      const res = await fetch(`${baseUrl}/api/debrid/config`, { method: "DELETE" });
      assert.equal(res.status, 200);

      const status = await fetch(`${baseUrl}/api/debrid/status`);
      const body = await status.json() as { configured: boolean };
      assert.equal(body.configured, false);
    });
  });

  // ── GET /api/debrid/verify ──────────────────────────────────────────

  describe("GET /api/debrid/verify", () => {
    it("returns configured: false when no config", async () => {
      // Ensure config is cleared
      await fetch(`${baseUrl}/api/debrid/config`, { method: "DELETE" });

      const res = await fetch(`${baseUrl}/api/debrid/verify`);
      assert.equal(res.status, 200);
      const body = await res.json() as { configured: boolean; valid: boolean };
      assert.equal(body.configured, false);
      assert.equal(body.valid, false);
    });
  });

  // ── POST /api/debrid/cached ─────────────────────────────────────────

  describe("POST /api/debrid/cached", () => {
    it("returns 400 when infoHashes is missing", async () => {
      const res = await fetch(`${baseUrl}/api/debrid/cached`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    });

    it("returns empty cached map when debrid not configured", async () => {
      await fetch(`${baseUrl}/api/debrid/config`, { method: "DELETE" });

      const res = await fetch(`${baseUrl}/api/debrid/cached`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ infoHashes: ["abc123", "def456"] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { cached: Record<string, boolean> };
      assert.deepEqual(body.cached, {});
    });
  });
});
