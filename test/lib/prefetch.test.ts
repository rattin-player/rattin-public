import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startPrefetch } from "../../lib/torrent/prefetch.js";

describe("startPrefetch mode branching", () => {
  it("calls warmCache in debrid mode", async () => {
    const calls: string[] = [];
    await startPrefetch({
      mode: "debrid",
      nextEp: { tmdbId: "1", season: 1, episode: 2 },
      deps: {
        resolveNext: async () => ({ infoHash: "abc", fileIndex: 0, magnet: "magnet:?xt=urn:btih:abc" }),
        warmCache: async (m) => { calls.push("warm:" + m); },
        addTorrent: async () => { calls.push("addTorrent"); },
        isFinished: () => false,
      },
    });
    assert.deepEqual(calls, ["warm:magnet:?xt=urn:btih:abc"]);
  });

  it("calls torrent-add in native mode", async () => {
    const calls: string[] = [];
    await startPrefetch({
      mode: "native",
      nextEp: { tmdbId: "1", season: 1, episode: 2 },
      deps: {
        resolveNext: async () => ({ infoHash: "abc", fileIndex: 2, magnet: "magnet:?xt=urn:btih:abc" }),
        warmCache: async () => { calls.push("warm"); },
        addTorrent: async (m, fi) => { calls.push(`add:${m}:${fi}`); },
        isFinished: () => false,
      },
    });
    assert.deepEqual(calls, ["add:magnet:?xt=urn:btih:abc:2"]);
  });

  it("short-circuits when isFinished returns true (replay guard)", async () => {
    const calls: string[] = [];
    await startPrefetch({
      mode: "debrid",
      nextEp: { tmdbId: "1", season: 1, episode: 2 },
      deps: {
        resolveNext: async () => { calls.push("resolve"); return { infoHash: "", fileIndex: 0, magnet: "" }; },
        warmCache: async () => { calls.push("warm"); },
        addTorrent: async () => { calls.push("add"); },
        isFinished: () => true,
      },
    });
    assert.deepEqual(calls, []);
  });

  it("skips add when next infoHash matches current (same season pack)", async () => {
    const calls: string[] = [];
    await startPrefetch({
      mode: "native",
      nextEp: { tmdbId: "1", season: 1, episode: 2 },
      currentInfoHash: "abc",
      deps: {
        resolveNext: async () => ({ infoHash: "abc", fileIndex: 3, magnet: "m" }),
        warmCache: async () => { calls.push("warm"); },
        addTorrent: async () => { calls.push("add"); },
        isFinished: () => false,
      },
    });
    assert.deepEqual(calls, []);
  });
});
