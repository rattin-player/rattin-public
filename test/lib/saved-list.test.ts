import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
import { mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { JsonStore } from "../../lib/store.js";
import { SavedList, type SavedItem } from "../../lib/saved-list.js";

let tmpDir: string;
let store: JsonStore<SavedItem>;
let sl: SavedList;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "rattin-sl-test-"));
  store = new JsonStore<SavedItem>(path.join(tmpDir, "sl.json"));
  sl = new SavedList(store);
});

afterEach(() => {
  store.shutdown();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SavedList", () => {
  it("toggle adds and removes items", () => {
    const saved = sl.toggle({ tmdbId: 1, mediaType: "movie", title: "Test", posterPath: null });
    assert.equal(saved, true);
    assert.equal(sl.isSaved("movie", 1), true);

    const unsaved = sl.toggle({ tmdbId: 1, mediaType: "movie", title: "Test", posterPath: null });
    assert.equal(unsaved, false);
    assert.equal(sl.isSaved("movie", 1), false);
  });

  it("isSaved returns false for unknown items", () => {
    assert.equal(sl.isSaved("movie", 999), false);
  });

  it("getAll returns items sorted by most recently saved", async () => {
    sl.toggle({ tmdbId: 1, mediaType: "movie", title: "First", posterPath: null });
    await sleep(10);
    sl.toggle({ tmdbId: 2, mediaType: "tv", title: "Second", posterPath: null });
    await sleep(10);
    sl.toggle({ tmdbId: 3, mediaType: "movie", title: "Third", posterPath: null });
    const items = sl.getAll();
    assert.equal(items.length, 3);
    assert.equal(items[0].tmdbId, 3); // most recent first
    assert.equal(items[2].tmdbId, 1);
  });

  it("separates movies and TV by key", () => {
    sl.toggle({ tmdbId: 1, mediaType: "movie", title: "Movie", posterPath: null });
    sl.toggle({ tmdbId: 1, mediaType: "tv", title: "Show", posterPath: null });
    assert.equal(sl.isSaved("movie", 1), true);
    assert.equal(sl.isSaved("tv", 1), true);
    assert.equal(sl.getAll().length, 2);
  });

  it("persists through store shutdown and reload", () => {
    const filePath = path.join(tmpDir, "persist.json");
    const store1 = new JsonStore<SavedItem>(filePath);
    const sl1 = new SavedList(store1);
    sl1.toggle({ tmdbId: 42, mediaType: "movie", title: "Persist Test", posterPath: null });
    store1.shutdown();

    const store2 = new JsonStore<SavedItem>(filePath);
    const sl2 = new SavedList(store2);
    assert.equal(sl2.isSaved("movie", 42), true);
    store2.shutdown();
  });
});
