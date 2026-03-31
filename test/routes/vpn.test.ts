import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../helpers/mock-app.js";

describe("VPN routes", () => {
  let baseUrl: string, close: () => Promise<void>;

  before(async () => {
    ({ baseUrl, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  // ── GET /api/vpn/status ─────────────────────────────────────────────

  describe("GET /api/vpn/status", () => {
    it("returns status with active and configured fields", async () => {
      const res = await fetch(`${baseUrl}/api/vpn/status`);
      assert.equal(res.status, 200);
      const body = await res.json() as { active: boolean; configured: boolean };
      assert.equal(typeof body.active, "boolean");
      assert.equal(typeof body.configured, "boolean");
      // No WireGuard config in test env
      assert.equal(body.active, false);
    });
  });

  // ── POST /api/vpn/toggle ────────────────────────────────────────────

  describe("POST /api/vpn/toggle", () => {
    it("returns 400 when action is missing", async () => {
      const res = await fetch(`${baseUrl}/api/vpn/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.ok(body.error.includes("action"));
    });

    it("returns 400 for invalid action", async () => {
      const res = await fetch(`${baseUrl}/api/vpn/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "maybe" }),
      });
      assert.equal(res.status, 400);
    });

    it("returns 400 when no WireGuard config exists", async () => {
      const res = await fetch(`${baseUrl}/api/vpn/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "on" }),
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.ok(body.error.includes("WireGuard") || body.error.includes("config") || body.error.includes("supervisor"));
    });
  });

  // ── GET /api/vpn/verify ─────────────────────────────────────────────

  describe("GET /api/vpn/verify", () => {
    it("returns IP info", async () => {
      const res = await fetch(`${baseUrl}/api/vpn/verify`);
      // May fail in CI without internet, but should at least respond
      assert.ok(res.status === 200 || res.status === 500);
      const body = await res.json() as { ip?: string; error?: string };
      if (res.status === 200) {
        assert.ok(body.ip, "should have ip field");
      }
    });
  });
});
