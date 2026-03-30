import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, mockClient } from "../helpers/mock-app.js";

describe("GET /api/stream/:infoHash/:fileIndex", () => {
  let baseUrl, close, client;

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
    const body = await res.json();
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
    const body = await res.json();
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
    const body = await res.json();
    assert.equal(body.error, "File type not allowed");
  });
});
