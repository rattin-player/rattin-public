import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../helpers/mock-app.js";

describe("Storage routes", () => {
  let baseUrl: string, close: () => Promise<void>;

  before(async () => {
    ({ baseUrl, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  // ── Watch History ──────────────────────────────────────────────────

  describe("PUT /api/watch-history/progress", () => {
    it("saves progress and returns ok", async () => {
      const res = await fetch(`${baseUrl}/api/watch-history/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId: 100, mediaType: "tv", title: "Test Show — S1E1",
          posterPath: null, season: 1, episode: 1, position: 600, duration: 2400,
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { ok: boolean };
      assert.equal(body.ok, true);
    });

    it("rejects missing fields", async () => {
      const res = await fetch(`${baseUrl}/api/watch-history/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: 100 }),
      });
      assert.equal(res.status, 400);
    });

    it("rejects invalid mediaType", async () => {
      const res = await fetch(`${baseUrl}/api/watch-history/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId: 100, mediaType: "podcast", title: "Bad", position: 10, duration: 100,
        }),
      });
      assert.equal(res.status, 400);
    });

    it("rejects non-numeric tmdbId", async () => {
      const res = await fetch(`${baseUrl}/api/watch-history/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId: "abc", mediaType: "movie", title: "Bad", position: 10, duration: 100,
        }),
      });
      assert.equal(res.status, 400);
    });

    it("also accepts POST (for sync XHR on unmount)", async () => {
      const res = await fetch(`${baseUrl}/api/watch-history/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId: 101, mediaType: "movie", title: "Movie Test",
          posterPath: null, position: 1000, duration: 7200,
        }),
      });
      assert.equal(res.status, 200);
    });
  });

  describe("GET /api/watch-history/continue", () => {
    it("returns items array", async () => {
      const res = await fetch(`${baseUrl}/api/watch-history/continue`);
      assert.equal(res.status, 200);
      const body = await res.json() as { items: unknown[] };
      assert.ok(Array.isArray(body.items));
    });

    it("includes unfinished items with >= 5 min watched", async () => {
      // Save a record with 10 min watched
      await fetch(`${baseUrl}/api/watch-history/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId: 200, mediaType: "tv", title: "Continue Test — S1E1",
          posterPath: null, season: 1, episode: 1, position: 600, duration: 2400,
        }),
      });
      const res = await fetch(`${baseUrl}/api/watch-history/continue`);
      const body = await res.json() as { items: Array<{ tmdbId: number }> };
      assert.ok(body.items.some((i) => i.tmdbId === 200));
    });

    it("has no-cache header", async () => {
      const res = await fetch(`${baseUrl}/api/watch-history/continue`);
      assert.equal(res.headers.get("cache-control"), "no-store");
    });
  });

  describe("GET /api/watch-history/resume/:tmdbId", () => {
    it("returns null for unwatched content", async () => {
      const res = await fetch(`${baseUrl}/api/watch-history/resume/99999?mediaType=tv`);
      assert.equal(res.status, 200);
      const body = await res.json() as { resumePoint: null };
      assert.equal(body.resumePoint, null);
    });

    it("returns resume point for in-progress content", async () => {
      await fetch(`${baseUrl}/api/watch-history/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId: 300, mediaType: "tv", title: "Resume Test — S2E5",
          posterPath: null, season: 2, episode: 5, position: 1200, duration: 2400,
        }),
      });
      const res = await fetch(`${baseUrl}/api/watch-history/resume/300?mediaType=tv`);
      const body = await res.json() as { resumePoint: { season: number; episode: number; position: number } };
      assert.ok(body.resumePoint);
      assert.equal(body.resumePoint.season, 2);
      assert.equal(body.resumePoint.episode, 5);
      assert.equal(body.resumePoint.position, 1200);
    });
  });

  describe("GET /api/watch-history/series/:tmdbId", () => {
    it("returns episodes for a series", async () => {
      await fetch(`${baseUrl}/api/watch-history/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId: 400, mediaType: "tv", title: "Series Test — S1E1",
          posterPath: null, season: 1, episode: 1, position: 600, duration: 2400,
        }),
      });
      const res = await fetch(`${baseUrl}/api/watch-history/series/400`);
      assert.equal(res.status, 200);
      const body = await res.json() as { episodes: Array<{ episode: number }> };
      assert.ok(body.episodes.length > 0);
    });
  });

  describe("POST /api/watch-history/dismiss", () => {
    it("dismisses an episode without deleting data", async () => {
      // Save progress
      await fetch(`${baseUrl}/api/watch-history/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId: 500, mediaType: "tv", title: "Dismiss Test — S1E1",
          posterPath: null, season: 1, episode: 1, position: 600, duration: 2400,
        }),
      });
      // Dismiss
      const res = await fetch(`${baseUrl}/api/watch-history/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: 500, mediaType: "tv", season: 1, episode: 1 }),
      });
      assert.equal(res.status, 200);

      // Should not appear in continue watching
      const cwRes = await fetch(`${baseUrl}/api/watch-history/continue`);
      const cwBody = await cwRes.json() as { items: Array<{ tmdbId: number; episode: number }> };
      assert.ok(!cwBody.items.some((i) => i.tmdbId === 500 && i.episode === 1));

      // But data should still exist in series progress
      const spRes = await fetch(`${baseUrl}/api/watch-history/series/500`);
      const spBody = await spRes.json() as { episodes: Array<{ episode: number; position: number }> };
      assert.ok(spBody.episodes.some((e) => e.episode === 1 && e.position === 600));
    });
  });

  // ── Saved List ─────────────────────────────────────────────────────

  describe("POST /api/saved/toggle", () => {
    it("toggles saved state", async () => {
      const res1 = await fetch(`${baseUrl}/api/saved/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: 600, mediaType: "movie", title: "Save Test", posterPath: null }),
      });
      assert.equal(res1.status, 200);
      const body1 = await res1.json() as { saved: boolean };
      assert.equal(body1.saved, true);

      const res2 = await fetch(`${baseUrl}/api/saved/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: 600, mediaType: "movie", title: "Save Test", posterPath: null }),
      });
      const body2 = await res2.json() as { saved: boolean };
      assert.equal(body2.saved, false);
    });

    it("rejects invalid mediaType", async () => {
      const res = await fetch(`${baseUrl}/api/saved/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: 1, mediaType: "invalid", title: "Bad" }),
      });
      assert.equal(res.status, 400);
    });
  });

  describe("GET /api/saved/:mediaType/:tmdbId", () => {
    it("returns saved state", async () => {
      await fetch(`${baseUrl}/api/saved/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: 700, mediaType: "tv", title: "Check Test", posterPath: null }),
      });
      const res = await fetch(`${baseUrl}/api/saved/tv/700`);
      assert.equal(res.status, 200);
      const body = await res.json() as { saved: boolean };
      assert.equal(body.saved, true);
    });

    it("returns false for unsaved item", async () => {
      const res = await fetch(`${baseUrl}/api/saved/movie/99999`);
      const body = await res.json() as { saved: boolean };
      assert.equal(body.saved, false);
    });
  });

  describe("GET /api/saved", () => {
    it("returns all saved items", async () => {
      const res = await fetch(`${baseUrl}/api/saved`);
      assert.equal(res.status, 200);
      const body = await res.json() as { items: unknown[] };
      assert.ok(Array.isArray(body.items));
    });
  });
});
