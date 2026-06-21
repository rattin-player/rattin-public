import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  jobKey,
  registerCache,
  cleanupHash,
  pruneOrphans,
  cacheStats,
} from "../../../lib/cache/torrent-caches.js";

// ── jobKey() — stateless, test freely ──

describe("jobKey()", () => {
  it("returns lowercase normalized key", () => {
    assert.equal(jobKey("ABC123", 0), "abc123:0");
  });

  it("handles string fileIndex", () => {
    assert.equal(jobKey("abc", "5"), "abc:5");
  });

  it("passes through already-lowercase hash", () => {
    assert.equal(jobKey("abc123", 2), "abc123:2");
  });
});

// ── Registry functions — ordered suite (global state accumulates) ──
// We create fresh Maps for each group of tests and register them.
// Since _registered is append-only and never reset, each describe block
// registers its OWN maps and only asserts on those maps.

describe("registerCache + cleanupHash", () => {
  const hashIndexMap = new Map<string, string>();
  const hashMap = new Map<string, string>();
  const pathMap = new Map<string, string>();

  // Register once at suite load time
  registerCache("test-hashindex", hashIndexMap, "hash:index");
  registerCache("test-hash", hashMap, "hash");
  registerCache("test-path", pathMap, "path");

  it("cleans up hash:index entries by prefix", () => {
    hashIndexMap.set("deadbeef:0", "val-a");
    hashIndexMap.set("deadbeef:1", "val-b");
    hashIndexMap.set("otherhash:0", "val-c");

    cleanupHash("deadbeef");

    assert.equal(hashIndexMap.has("deadbeef:0"), false);
    assert.equal(hashIndexMap.has("deadbeef:1"), false);
    assert.equal(hashIndexMap.has("otherhash:0"), true, "other hash entries must survive");
  });

  it("cleans up hash-keyed entries by exact key", () => {
    hashMap.set("deadbeef", "val-x");
    hashMap.set("otherhash", "val-y");

    cleanupHash("deadbeef");

    assert.equal(hashMap.has("deadbeef"), false);
    assert.equal(hashMap.has("otherhash"), true, "other hash entries must survive");
  });

  it("cleans up path-keyed entries using filePaths argument", () => {
    pathMap.set("/tmp/deadbeef/file.mp4", "probe-a");
    pathMap.set("/tmp/deadbeef/file2.mkv", "probe-b");
    pathMap.set("/tmp/otherhash/file.mp4", "probe-c");

    cleanupHash("deadbeef", ["/tmp/deadbeef/file.mp4", "/tmp/deadbeef/file2.mkv"]);

    assert.equal(pathMap.has("/tmp/deadbeef/file.mp4"), false);
    assert.equal(pathMap.has("/tmp/deadbeef/file2.mkv"), false);
    assert.equal(pathMap.has("/tmp/otherhash/file.mp4"), true, "other path entries must survive");
  });
});

describe("registerCache + pruneOrphans", () => {
  const hiMap = new Map<string, string>();
  const hMap = new Map<string, string>();
  const pMap = new Map<string, string>();

  registerCache("prune-hashindex", hiMap, "hash:index");
  registerCache("prune-hash", hMap, "hash");
  registerCache("prune-path", pMap, "path");

  it("prunes entries for inactive hashes, keeps active ones", () => {
    hiMap.set("aaa:0", "v1");
    hiMap.set("aaa:1", "v2");
    hiMap.set("bbb:0", "v3");
    hMap.set("aaa", "v4");
    hMap.set("bbb", "v5");

    const activeHashes = new Set(["aaa"]);
    const mockStatSync = () => {}; // not reached for non-path maps

    const pruned = pruneOrphans(activeHashes, mockStatSync as (path: string) => void);

    // "bbb" entries should be gone
    assert.equal(hiMap.has("bbb:0"), false);
    assert.equal(hMap.has("bbb"), false);

    // "aaa" entries should remain
    assert.equal(hiMap.has("aaa:0"), true);
    assert.equal(hiMap.has("aaa:1"), true);
    assert.equal(hMap.has("aaa"), true);

    // pruned count includes bbb:0 from hiMap + bbb from hMap = at least 2
    // (may be higher due to earlier registered caches from other suites)
    assert.ok(pruned >= 2, `expected at least 2 pruned, got ${pruned}`);
  });

  it("prunes path entries when statSync throws (file missing)", () => {
    pMap.set("/tmp/exists.mp4", "probe-yes");
    pMap.set("/tmp/gone.mp4", "probe-no");

    const activeHashes = new Set<string>(); // irrelevant for path-keyed
    const mockStatSync = (path: string) => {
      if (path === "/tmp/gone.mp4") throw new Error("ENOENT");
      // /tmp/exists.mp4 succeeds (no throw)
    };

    pruneOrphans(activeHashes, mockStatSync);

    assert.equal(pMap.has("/tmp/gone.mp4"), false, "missing file should be pruned");
    assert.equal(pMap.has("/tmp/exists.mp4"), true, "existing file should be kept");
  });
});

describe("cacheStats", () => {
  it("returns name-to-size mapping for all registered caches", () => {
    const stats = cacheStats();

    assert.equal(typeof stats, "object");
    // We registered caches with these names in earlier suites
    assert.equal(typeof stats["test-hashindex"], "number");
    assert.equal(typeof stats["test-hash"], "number");
    assert.equal(typeof stats["test-path"], "number");
    assert.equal(typeof stats["prune-hashindex"], "number");
    assert.equal(typeof stats["prune-hash"], "number");
    assert.equal(typeof stats["prune-path"], "number");
  });
});
