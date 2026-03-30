import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../helpers/mock-app.js";

describe("TMDB routes", () => {
  let baseUrl: string, close: () => Promise<void>;

  before(async () => {
    ({ baseUrl, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  // ── GET /api/tmdb/trending ────────────────────────────────────────────

  describe("GET /api/tmdb/trending", () => {
    it("returns 502 or 503 when TMDB API key is not set", async () => {
      const res = await fetch(`${baseUrl}/api/tmdb/trending`);
      assert.ok(
        res.status === 502 || res.status === 503,
        `expected 502 or 503, got ${res.status}`
      );
    });
  });

  // ── GET /api/tmdb/search ──────────────────────────────────────────────

  describe("GET /api/tmdb/search", () => {
    it("returns 502 or 503 when TMDB API key is not set", async () => {
      const res = await fetch(`${baseUrl}/api/tmdb/search?q=test`);
      assert.ok(
        res.status === 502 || res.status === 503,
        `expected 502 or 503, got ${res.status}`
      );
    });
  });

  // ── GET /api/tmdb/movie/:id ───────────────────────────────────────────

  describe("GET /api/tmdb/movie/:id", () => {
    it("returns 502 or 503 when TMDB API key is not set", async () => {
      const res = await fetch(`${baseUrl}/api/tmdb/movie/550`);
      assert.ok(
        res.status === 502 || res.status === 503,
        `expected 502 or 503, got ${res.status}`
      );
    });
  });

  // ── GET /api/tmdb/tv/:id ──────────────────────────────────────────────

  describe("GET /api/tmdb/tv/:id", () => {
    it("returns 502 or 503 when TMDB API key is not set", async () => {
      const res = await fetch(`${baseUrl}/api/tmdb/tv/1399`);
      assert.ok(
        res.status === 502 || res.status === 503,
        `expected 502 or 503, got ${res.status}`
      );
    });
  });

  // ── GET /api/tmdb/tv/:id/season/:num ─────────────────────────────────

  describe("GET /api/tmdb/tv/:id/season/:num", () => {
    it("returns 502 or 503 when TMDB API key is not set", async () => {
      const res = await fetch(`${baseUrl}/api/tmdb/tv/1399/season/1`);
      assert.ok(
        res.status === 502 || res.status === 503,
        `expected 502 or 503, got ${res.status}`
      );
    });
  });

  // ── GET /api/reviews/:type/:id ────────────────────────────────────────

  describe("GET /api/reviews/:type/:id", () => {
    it("returns 400 for invalid type", async () => {
      const res = await fetch(`${baseUrl}/api/reviews/invalid/123`);
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.equal(body.error, "Invalid type");
    });

    it("returns 502 or 503 for movie type when TMDB API key is not set", async () => {
      const res = await fetch(`${baseUrl}/api/reviews/movie/550`);
      assert.ok(
        res.status === 502 || res.status === 503,
        `expected 502 or 503, got ${res.status}`
      );
    });
  });
});
