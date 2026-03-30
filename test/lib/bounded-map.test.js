import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BoundedMap } from "../../lib/bounded-map.js";

describe("BoundedMap", () => {
  it("extends Map", () => {
    const m = new BoundedMap(5);
    assert.ok(m instanceof Map);
  });

  it("stores and retrieves values", () => {
    const m = new BoundedMap(5);
    m.set("a", 1);
    m.set("b", 2);
    assert.equal(m.get("a"), 1);
    assert.equal(m.get("b"), 2);
  });

  it("evicts oldest entry when exceeding maxSize", () => {
    const m = new BoundedMap(3);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    m.set("d", 4); // should evict "a"
    assert.equal(m.size, 3);
    assert.equal(m.has("a"), false);
    assert.equal(m.get("d"), 4);
  });

  it("evicts multiple oldest when inserting many beyond limit", () => {
    const m = new BoundedMap(2);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    m.set("d", 4);
    assert.equal(m.size, 2);
    assert.equal(m.has("a"), false);
    assert.equal(m.has("b"), false);
    assert.equal(m.has("c"), true);
    assert.equal(m.has("d"), true);
  });

  it("refreshes position when re-setting existing key", () => {
    const m = new BoundedMap(3);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    // Re-set "a" — moves it to end, making "b" oldest
    m.set("a", 10);
    m.set("d", 4); // should evict "b" (oldest), not "a"
    assert.equal(m.size, 3);
    assert.equal(m.has("b"), false);
    assert.equal(m.get("a"), 10);
    assert.equal(m.get("d"), 4);
  });

  it("exposes maxSize property", () => {
    const m = new BoundedMap(42);
    assert.equal(m.maxSize, 42);
  });

  it("works with maxSize of 1", () => {
    const m = new BoundedMap(1);
    m.set("a", 1);
    m.set("b", 2);
    assert.equal(m.size, 1);
    assert.equal(m.has("a"), false);
    assert.equal(m.get("b"), 2);
  });

  it("delete() works normally", () => {
    const m = new BoundedMap(5);
    m.set("a", 1);
    m.delete("a");
    assert.equal(m.size, 0);
    assert.equal(m.has("a"), false);
  });

  it("clear() works normally", () => {
    const m = new BoundedMap(5);
    m.set("a", 1);
    m.set("b", 2);
    m.clear();
    assert.equal(m.size, 0);
  });

  it("is compatible with torrent-caches registry (iterates keys)", () => {
    const m = new BoundedMap(10);
    m.set("abc:0", "v1");
    m.set("abc:1", "v2");
    m.set("def:0", "v3");
    const keys = [...m.keys()];
    assert.deepEqual(keys, ["abc:0", "abc:1", "def:0"]);
  });
});
