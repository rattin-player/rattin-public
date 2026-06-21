import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { startTestServer, mockClient } from "../helpers/mock-app.js";
import type { MockClient } from "../helpers/mock-app.js";

describe("GET /api/stream/:infoHash/:fileIndex", () => {
  let baseUrl: string, close: () => Promise<void>, client: MockClient;

  before(async () => {
    client = mockClient();
    ({ baseUrl, close } = await startTestServer({ client }));
  });

  after(async () => {
    await close();
  });

  it("returns 404 for unknown torrent", async () => {
    const res = await fetch(`${baseUrl}/api/stream/unknownhash/0`);
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "Torrent not found");
  });

  it("returns 404 for invalid file index (empty files array)", async () => {
    const torrent = {
      infoHash: "streamtest-nofile",
      name: "Test",
      files: [],
      progress: 0,
      downloaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      length: 1000,
      timeRemaining: Infinity,
      paused: false,
      pieceLength: 262144,
      bitfield: { get: () => true },
      pause: () => {},
      resume: () => {},
      destroy: () => {},
      select: () => {},
      deselect: () => {},
    };
    client.torrents.push(torrent);

    const res = await fetch(`${baseUrl}/api/stream/streamtest-nofile/0`);
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "File not found");
  });

  it("returns 403 for disallowed file type", async () => {
    const torrent = {
      infoHash: "streamtest",
      name: "Test",
      files: [
        {
          name: "virus.exe",
          length: 1000,
          downloaded: 1000,
          path: "test/virus.exe",
          select: () => {},
          deselect: () => {},
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
      bitfield: { get: () => true },
      pause: () => {},
      resume: () => {},
      destroy: () => {},
      select: () => {},
      deselect: () => {},
    };
    client.torrents.push(torrent);

    const res = await fetch(`${baseUrl}/api/stream/streamtest/0`);
    assert.equal(res.status, 403);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "File type not allowed");
  });

  it("prioritizes subtitle files via piece selection instead of deselecting them", async () => {
    const calls: Record<string, string[]> = { selected: [], deselected: [], pieceSelected: [] };
    const torrent = {
      infoHash: "streamtest-subs",
      name: "Test",
      files: [
        {
          name: "movie.mkv",
          length: 500000,
          downloaded: 500000,
          path: "test/movie.mkv",
          offset: 0,
          select: () => { calls.selected.push("movie.mkv"); },
          deselect: () => { calls.deselected.push("movie.mkv"); },
          createReadStream: () => new Readable({ read() { this.push(null); } }),
        },
        {
          name: "movie.srt",
          length: 5000,
          downloaded: 0,
          path: "test/movie.srt",
          offset: 500000,
          select: () => { calls.selected.push("movie.srt"); },
          deselect: () => { calls.deselected.push("movie.srt"); },
        },
        {
          name: "movie.ass",
          length: 8000,
          downloaded: 0,
          path: "test/movie.ass",
          offset: 505000,
          select: () => { calls.selected.push("movie.ass"); },
          deselect: () => { calls.deselected.push("movie.ass"); },
        },
        {
          name: "extras.mkv",
          length: 300000,
          downloaded: 0,
          path: "test/extras.mkv",
          offset: 513000,
          select: () => { calls.selected.push("extras.mkv"); },
          deselect: () => { calls.deselected.push("extras.mkv"); },
        },
      ],
      progress: 0,
      downloaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      length: 813000,
      timeRemaining: Infinity,
      paused: false,
      pieceLength: 262144,
      bitfield: { get: () => false },
      pause: () => {},
      resume: () => {},
      destroy: () => {},
      select: (...args: unknown[]) => { calls.pieceSelected.push(JSON.stringify(args)); },
      deselect: () => {},
    };
    client.torrents.push(torrent);

    // The stream request will fail to actually transcode (no real file),
    // but file selection happens before that — which is what we're testing
    await fetch(`${baseUrl}/api/stream/streamtest-subs/0`);

    // Subtitle files get deselected at file level, then re-selected at piece level with priority
    // This ensures they download but don't block the video stream
    assert.ok(calls.deselected.includes("movie.srt"), "SRT should be file-deselected first");
    assert.ok(calls.deselected.includes("movie.ass"), "ASS should be file-deselected first");
    assert.ok(calls.pieceSelected.length > 0, "Piece-level select should be called for subtitle files");

    // Non-subtitle, non-video files should still be deselected
    assert.ok(calls.deselected.includes("extras.mkv"), "Other video files should be deselected");
  });
});
