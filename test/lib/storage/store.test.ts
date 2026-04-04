import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import { JsonStore } from "../../../lib/storage/store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "rattin-store-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("JsonStore", () => {
  it("stores and retrieves values", () => {
    const store = new JsonStore<number>(path.join(tmpDir, "test.json"));
    store.set("a", 1);
    store.set("b", 2);
    assert.equal(store.get("a"), 1);
    assert.equal(store.get("b"), 2);
    assert.equal(store.get("c"), undefined);
    store.shutdown();
  });

  it("deletes values", () => {
    const store = new JsonStore<number>(path.join(tmpDir, "test.json"));
    store.set("a", 1);
    assert.equal(store.delete("a"), true);
    assert.equal(store.get("a"), undefined);
    assert.equal(store.delete("a"), false);
    store.shutdown();
  });

  it("has() checks existence", () => {
    const store = new JsonStore<number>(path.join(tmpDir, "test.json"));
    store.set("a", 1);
    assert.equal(store.has("a"), true);
    assert.equal(store.has("b"), false);
    store.shutdown();
  });

  it("values() and entries() return snapshots", () => {
    const store = new JsonStore<number>(path.join(tmpDir, "test.json"));
    store.set("a", 1);
    store.set("b", 2);
    assert.deepEqual(store.values().sort(), [1, 2]);
    assert.equal(store.entries().length, 2);
    store.shutdown();
  });

  it("query() filters values", () => {
    const store = new JsonStore<number>(path.join(tmpDir, "test.json"));
    store.set("a", 1);
    store.set("b", 5);
    store.set("c", 3);
    const result = store.query((v) => v > 2);
    assert.deepEqual(result.sort(), [3, 5]);
    store.shutdown();
  });

  it("flush() persists to disk", () => {
    const filePath = path.join(tmpDir, "test.json");
    const store = new JsonStore<number>(filePath);
    store.set("x", 42);
    store.flush();
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(raw.x, 42);
    store.shutdown();
  });

  it("loads existing data from disk on construction", () => {
    const filePath = path.join(tmpDir, "test.json");
    const store1 = new JsonStore<number>(filePath);
    store1.set("x", 42);
    store1.shutdown();

    const store2 = new JsonStore<number>(filePath);
    assert.equal(store2.get("x"), 42);
    store2.shutdown();
  });

  it("handles corrupt file gracefully", () => {
    const filePath = path.join(tmpDir, "test.json");
    writeFileSync(filePath, "not json{{{");
    const store = new JsonStore<number>(filePath);
    assert.equal(store.size, 0);
    store.shutdown();
  });

  it("handles missing file gracefully", () => {
    const store = new JsonStore<number>(path.join(tmpDir, "nonexistent.json"));
    assert.equal(store.size, 0);
    store.shutdown();
  });

  it("shutdown() flushes and stops timer", () => {
    const filePath = path.join(tmpDir, "test.json");
    const store = new JsonStore<number>(filePath);
    store.set("a", 1);
    store.shutdown();
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(raw.a, 1);
  });

  it("creates parent directories if they don't exist", () => {
    const filePath = path.join(tmpDir, "nested", "deep", "test.json");
    const store = new JsonStore<number>(filePath);
    store.set("a", 1);
    store.flush();
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).a, 1);
    store.shutdown();
  });
});
