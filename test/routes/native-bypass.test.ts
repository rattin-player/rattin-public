import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { startTestServer, mockClient } from "../helpers/mock-app.js";
import type { MockClient } from "../helpers/mock-app.js";

describe("GET /api/stream/:infoHash/:fileIndex (legacy native=1 param is ignored)", () => {
  let baseUrl: string, close: () => Promise<void>, client: MockClient;

  before(async () => {
    client = mockClient();
    ({ baseUrl, close } = await startTestServer({ client }));
  });

  after(async () => {
    await close();
  });

  it("returns 404 for unknown torrent even with native=1", async () => {
    const res = await fetch(`${baseUrl}/api/stream/unknownhash/0?native=1`);
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "Torrent not found");
  });

  it("returns 403 for disallowed file type even with native=1", async () => {
    const torrent = {
      infoHash: "native-bypass-exe",
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

    const res = await fetch(`${baseUrl}/api/stream/native-bypass-exe/0?native=1`);
    assert.equal(res.status, 403);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "File type not allowed");
  });

  it("accepts native=1 param for a valid mkv file without erroring on the param itself", async () => {
    const torrent = {
      infoHash: "native-bypass-mkv",
      name: "Test",
      files: [
        {
          name: "movie.mkv",
          length: 500000,
          downloaded: 0,
          path: "test/movie.mkv",
          offset: 0,
          select: () => {},
          deselect: () => {},
          createReadStream: () => {
              return new Readable({ read() { this.push(null); } });
          },
        },
      ],
      progress: 0,
      downloaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      length: 500000,
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
    client.torrents.push(torrent);

    // native=1 should be accepted — the request either succeeds or fails for a
    // real media reason (probe/transcode), never with a 400 "bad query param" error
    const res = await fetch(`${baseUrl}/api/stream/native-bypass-mkv/0?native=1`);
    assert.notEqual(res.status, 400, "native=1 param must not cause a 400 Bad Request");
  });
});
