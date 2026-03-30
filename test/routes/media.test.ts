import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, mockClient } from "../helpers/mock-app.js";
import type { MockClient, TestServerResult } from "../helpers/mock-app.js";

/** Build a mock torrent that the media routes can find and work with. */
function makeMockTorrent(infoHash = "mediatest") {
  return {
    infoHash,
    name: "Test",
    files: [
      {
        name: "video.mp4",
        length: 1000,
        downloaded: 1000,
        path: "nonexistent/video.mp4",
        offset: 0,
      },
    ],
    progress: 0,
    downloaded: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    numPeers: 0,
    length: 1000,
    timeRemaining: Infinity,
    paused: false,
    pieceLength: 262144,
    bitfield: { get: () => false },
    pause: () => {},
    resume: () => {},
    destroy: () => {},
    select: () => {},
    deselect: () => {},
  };
}

describe("Media routes", () => {
  let baseUrl: string, close: () => Promise<void>, client: MockClient;

  before(async () => {
    client = mockClient();
    ({ baseUrl, close } = await startTestServer({ client }) as TestServerResult);
  });

  after(async () => {
    await close();
  });

  // ── GET /api/duration ─────────────────────────────────────────────────

  describe("GET /api/duration/:hash/:fileIndex", () => {
    it("returns 404 when torrent not found", async () => {
      const res = await fetch(`${baseUrl}/api/duration/nonexistent/0`);
      assert.equal(res.status, 404);
      const body = await res.json() as { error: string };
      assert.equal(body.error, "Torrent not found");
    });

    it("returns 200 with { duration: null } when file is not on disk", async () => {
      const torrent = makeMockTorrent("mediatest-duration");
      client.torrents.push(torrent);
      try {
        const res = await fetch(`${baseUrl}/api/duration/mediatest-duration/0`);
        assert.equal(res.status, 200);
        const body = await res.json() as { duration: number | null };
        assert.ok(Object.hasOwn(body, "duration"), "response should have duration key");
        assert.equal(body.duration, null);
      } finally {
        client.torrents = client.torrents.filter((t) => t !== torrent);
      }
    });
  });

  // ── GET /api/subtitles ────────────────────────────────────────────────

  describe("GET /api/subtitles/:hash/:fileIndex", () => {
    it("returns 404 when torrent not found", async () => {
      const res = await fetch(`${baseUrl}/api/subtitles/nonexistent/0`);
      assert.equal(res.status, 404);
      const body = await res.json() as { error: string };
      assert.equal(body.error, "Torrent not found");
    });
  });

  // ── GET /api/audio-tracks ─────────────────────────────────────────────

  describe("GET /api/audio-tracks/:hash/:fileIndex", () => {
    it("returns 404 when torrent not found", async () => {
      const res = await fetch(`${baseUrl}/api/audio-tracks/nonexistent/0`);
      assert.equal(res.status, 404);
      const body = await res.json() as { error: string };
      assert.equal(body.error, "Torrent not found");
    });
  });

  // ── GET /api/subtitle ─────────────────────────────────────────────────

  describe("GET /api/subtitle/:hash/:fileIndex", () => {
    it("returns 404 when torrent not found", async () => {
      const res = await fetch(`${baseUrl}/api/subtitle/nonexistent/0`);
      assert.equal(res.status, 404);
      const body = await res.json() as { error: string };
      assert.equal(body.error, "Torrent not found");
    });
  });

  // ── GET /api/intro ────────────────────────────────────────────────────

  describe("GET /api/intro/:hash/:fileIndex", () => {
    it("returns 200 with a detected boolean for a torrent with a single video file", async () => {
      const torrent = makeMockTorrent("mediatest-intro");
      client.torrents.push(torrent);
      try {
        const res = await fetch(`${baseUrl}/api/intro/mediatest-intro/0`);
        assert.equal(res.status, 200);
        const body = await res.json() as { detected: boolean };
        assert.ok(Object.hasOwn(body, "detected"), "response should have detected key");
        assert.equal(typeof body.detected, "boolean");
      } finally {
        client.torrents = client.torrents.filter((t) => t !== torrent);
      }
    });
  });
});
