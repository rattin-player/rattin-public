import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, mockClient } from "../helpers/mock-app.js";
import type { TorrentClient } from "../../lib/types.js";

describe("Search routes", () => {
  let baseUrl: string, close: () => Promise<void>, client: TorrentClient;

  before(async () => {
    client = mockClient() as unknown as TorrentClient;
    ({ baseUrl, close } = await startTestServer({ client }));
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

    it("reuses preferred torrent when it contains the target episode", async () => {
      let selected = -1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const files: any[] = [
        { name: "Show.S01E04.1080p.mkv", length: 1000 },
        { name: "Show.S01E05.1080p.mkv", length: 1200, select() { selected = 1; } },
        { name: "Show.S01E06.1080p.mkv", length: 1100 },
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).torrents.push({
        infoHash: "abc123",
        name: "Show.S01.1080p.Pack",
        length: 3300,
        files,
      });

      const res = await fetch(`${baseUrl}/api/auto-play`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Show", type: "tv", season: 1, episode: 5,
          preferInfoHash: "abc123",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as {
        infoHash: string; fileIndex: number; fileName: string; torrentName: string; totalSize: number;
      };
      assert.equal(body.infoHash, "abc123");
      assert.equal(body.fileIndex, 1);
      assert.equal(body.fileName, "Show.S01E05.1080p.mkv");
      assert.equal(body.torrentName, "Show.S01.1080p.Pack");
      assert.equal(body.totalSize, 3300);
      assert.equal(selected, 1, "should have called select() on the matched file");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).torrents.length = 0;
    });

    it("ignores preferInfoHash when the torrent has no matching episode", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).torrents.push({
        infoHash: "def456",
        name: "Show.S01.1080p.Pack",
        length: 2000,
        files: [
          { name: "Show.S01E04.1080p.mkv", length: 1000, select() {} },
          { name: "Show.S01E06.1080p.mkv", length: 1000, select() {} },
        ],
      });
      // No reuse → falls through to the normal search, which in the test env
      // finds no real results and returns 404. That's what we're asserting:
      // the reuse path didn't claim the request.
      const res = await fetch(`${baseUrl}/api/auto-play`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Nonexistent Show", type: "tv", season: 1, episode: 5,
          preferInfoHash: "def456",
        }),
      });
      assert.notEqual(res.status, 200);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).torrents.length = 0;
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
