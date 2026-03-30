import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../helpers/mock-app.js";

describe("Search routes", () => {
  let baseUrl: string, close: () => Promise<void>;

  before(async () => {
    ({ baseUrl, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  // ── POST /api/search-streams ──────────────────────────────────────────

  describe("POST /api/search-streams", () => {
    it("returns 400 when body is empty", async () => {
      const res = await fetch(`${baseUrl}/api/search-streams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.ok(body.error, "should have an error field");
    });

    it("returns 200 with results array when title is provided", async () => {
      const res = await fetch(`${baseUrl}/api/search-streams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Test Movie", year: 2020, type: "movie" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { results: unknown[] };
      assert.ok(Object.prototype.hasOwnProperty.call(body, "results"), "should have results field");
      assert.ok(Array.isArray(body.results), "results should be an array");
    });
  });

  // ── POST /api/auto-play ───────────────────────────────────────────────

  describe("POST /api/auto-play", () => {
    it("returns 400 when body is empty", async () => {
      const res = await fetch(`${baseUrl}/api/auto-play`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.ok(body.error, "should have an error field");
    });
  });

  // ── POST /api/play-torrent ────────────────────────────────────────────

  describe("POST /api/play-torrent", () => {
    it("returns 400 when body is empty", async () => {
      const res = await fetch(`${baseUrl}/api/play-torrent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.ok(body.error, "should have an error field");
    });
  });

  // ── POST /api/check-availability ─────────────────────────────────────

  describe("POST /api/check-availability", () => {
    it("returns 200 with empty available array when items is empty", async () => {
      const res = await fetch(`${baseUrl}/api/check-availability`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { available: unknown[] };
      assert.ok(Object.prototype.hasOwnProperty.call(body, "available"), "should have available field");
      assert.deepEqual(body.available, [], "available should be an empty array");
    });
  });
});
