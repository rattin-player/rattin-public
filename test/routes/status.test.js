import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../helpers/mock-app.js";

describe("Status routes", () => {
  let baseUrl, close, client;

  before(async () => {
    ({ baseUrl, close, client } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  // ── GET /api/status/:infoHash ─────────────────────────────────────────

  describe("GET /api/status/:infoHash", () => {
    it("returns 404 for unknown torrent", async () => {
      const res = await fetch(`${baseUrl}/api/status/unknownhash`);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error, "Torrent not found");
    });

    it("returns 200 with status for an active torrent", async () => {
      const mockTorrent = {
        infoHash: "abc123",
        name: "Test",
        downloadSpeed: 0,
        uploadSpeed: 0,
        progress: 0,
        downloaded: 0,
        length: 1000,
        numPeers: 0,
        timeRemaining: Infinity,
        files: [
          {
            name: "video.mp4",
            length: 1000000,
            downloaded: 500000,
            path: "test/video.mp4",
          },
        ],
      };
      client.torrents.push(mockTorrent);

      try {
        const res = await fetch(`${baseUrl}/api/status/abc123`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.infoHash, "abc123");
        assert.ok(Array.isArray(body.files), "files should be an array");
        assert.equal(body.files.length, 1);
        assert.equal(typeof body.downloadSpeed, "number");
        assert.equal(typeof body.numPeers, "number");
        assert.equal(typeof body.progress, "number");
      } finally {
        client.torrents = client.torrents.filter((t) => t.infoHash !== "abc123");
      }
    });
  });

  // ── POST /api/set-active/:infoHash ───────────────────────────────────

  describe("POST /api/set-active/:infoHash", () => {
    it("returns 200 with { ok: true }", async () => {
      const res = await fetch(`${baseUrl}/api/set-active/somehash`, {
        method: "POST",
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    });
  });
});
