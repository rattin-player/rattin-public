import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TTLCache, CACHE_TTL } from "../lib/cache.js";

describe("TTLCache", () => {
  let cache;

  beforeEach(() => {
    cache = new TTLCache(1000); // 1 second default TTL
  });

  describe("basic operations", () => {
    it("set and get a value", () => {
      cache.set("key", "value");
      assert.equal(cache.get("key"), "value");
    });

    it("returns undefined for missing key", () => {
      assert.equal(cache.get("missing"), undefined);
    });

    it("has() returns true for existing key", () => {
      cache.set("key", "value");
      assert.equal(cache.has("key"), true);
    });

    it("has() returns false for missing key", () => {
      assert.equal(cache.has("missing"), false);
    });

    it("tracks size", () => {
      assert.equal(cache.size, 0);
      cache.set("a", 1);
      cache.set("b", 2);
      assert.equal(cache.size, 2);
    });

    it("clear() removes all entries", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.clear();
      assert.equal(cache.size, 0);
      assert.equal(cache.get("a"), undefined);
    });

    it("overwrites existing keys", () => {
      cache.set("key", "first");
      cache.set("key", "second");
      assert.equal(cache.get("key"), "second");
      assert.equal(cache.size, 1);
    });
  });

  describe("TTL expiry", () => {
    it("returns undefined after TTL expires", async () => {
      cache = new TTLCache(50); // 50ms TTL
      cache.set("key", "value");
      assert.equal(cache.get("key"), "value");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(cache.get("key"), undefined);
    });

    it("custom TTL per entry overrides default", async () => {
      cache = new TTLCache(10000); // 10s default
      cache.set("short", "value", 50); // 50ms TTL
      cache.set("long", "value"); // uses default 10s
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(cache.get("short"), undefined);
      assert.equal(cache.get("long"), "value");
    });

    it("has() returns false after expiry", async () => {
      cache = new TTLCache(50);
      cache.set("key", "value");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(cache.has("key"), false);
    });
  });

  describe("getStale", () => {
    it("returns value with stale=false when fresh", () => {
      cache.set("key", "value");
      const result = cache.getStale("key");
      assert.equal(result.value, "value");
      assert.equal(result.stale, false);
    });

    it("returns value with stale=true when expired", async () => {
      cache = new TTLCache(50);
      cache.set("key", "value");
      await new Promise((r) => setTimeout(r, 60));
      const result = cache.getStale("key");
      assert.equal(result.value, "value");
      assert.equal(result.stale, true);
    });

    it("returns undefined with stale=false when missing", () => {
      const result = cache.getStale("missing");
      assert.equal(result.value, undefined);
      assert.equal(result.stale, false);
    });
  });

  describe("purgeExpired", () => {
    it("removes only expired entries", async () => {
      cache = new TTLCache(50);
      cache.set("expires", "value");
      cache.set("stays", "value", 10000);
      await new Promise((r) => setTimeout(r, 60));
      const removed = cache.purgeExpired();
      assert.equal(removed, 1);
      assert.equal(cache.get("stays"), "value");
      assert.equal(cache.get("expires"), undefined);
    });

    it("returns 0 when nothing expired", () => {
      cache.set("key", "value");
      assert.equal(cache.purgeExpired(), 0);
    });
  });

  describe("eviction", () => {
    it("evicts oldest entries when exceeding max", () => {
      // TTLCache has MAX_ENTRIES = 5000, we can't easily test that without
      // inserting 5001 entries. Instead, verify the mechanism works by checking
      // that the cache doesn't grow unbounded.
      cache = new TTLCache(60000);
      for (let i = 0; i < 5100; i++) {
        cache.set(`key${i}`, i);
      }
      // After eviction, size should be <= MAX_ENTRIES
      assert.ok(cache.size <= 5000, `Cache size ${cache.size} exceeds max`);
    });
  });

  describe("stats", () => {
    it("returns entries count and max", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      const s = cache.stats();
      assert.equal(s.entries, 2);
      assert.equal(s.maxEntries, 5000);
    });
  });
});

describe("CACHE_TTL constants", () => {
  it("has expected keys", () => {
    assert.ok(CACHE_TTL.MOVIE > 0);
    assert.ok(CACHE_TTL.TV > 0);
    assert.ok(CACHE_TTL.SEASON > 0);
    assert.ok(CACHE_TTL.GENRES > 0);
    assert.ok(CACHE_TTL.TRENDING > 0);
    assert.ok(CACHE_TTL.DISCOVER > 0);
    assert.ok(CACHE_TTL.SEARCH > 0);
  });

  it("MOVIE TTL is longer than TRENDING TTL", () => {
    assert.ok(CACHE_TTL.MOVIE > CACHE_TTL.TRENDING);
  });
});
