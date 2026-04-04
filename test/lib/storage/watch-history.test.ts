import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { JsonStore } from "../../../lib/storage/store.js";
import { WatchHistory, type WatchRecord } from "../../../lib/storage/watch-history.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmpDir: string;
let store: JsonStore<WatchRecord>;
let wh: WatchHistory;

function makeRecord(overrides: Partial<WatchRecord> = {}): WatchRecord {
  return {
    tmdbId: 1000,
    mediaType: "tv",
    title: "Test Show — S1E1",
    posterPath: null,
    season: 1,
    episode: 1,
    position: 600,
    duration: 2400,
    finished: false,
    updatedAt: "",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "rattin-wh-test-"));
  store = new JsonStore<WatchRecord>(path.join(tmpDir, "wh.json"));
  wh = new WatchHistory(store);
});

afterEach(() => {
  store.shutdown();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── recordProgress ──────────────────────────────────────────────────

describe("WatchHistory.recordProgress", () => {
  it("stores a record and sets updatedAt", () => {
    wh.recordProgress(makeRecord({ tmdbId: 42, season: 1, episode: 1, position: 300, duration: 2400 }));
    const r = wh.getProgress("tv", 42, 1, 1);
    assert.ok(r);
    assert.equal(r.position, 300);
    assert.equal(r.finished, false);
    assert.ok(r.updatedAt.length > 0);
  });

  it("marks finished at 90% threshold", () => {
    wh.recordProgress(makeRecord({ position: 2160, duration: 2400 })); // 90%
    assert.equal(wh.getProgress("tv", 1000, 1, 1)!.finished, true);
  });

  it("not finished at 89%", () => {
    wh.recordProgress(makeRecord({ position: 2136, duration: 2400 })); // 89%
    assert.equal(wh.getProgress("tv", 1000, 1, 1)!.finished, false);
  });

  it("preserves existing duration when new report has duration=0", () => {
    wh.recordProgress(makeRecord({ position: 600, duration: 2400 }));
    wh.recordProgress(makeRecord({ position: 800, duration: 0 }));
    assert.equal(wh.getProgress("tv", 1000, 1, 1)!.duration, 2400);
    assert.equal(wh.getProgress("tv", 1000, 1, 1)!.position, 800);
  });

  it("clears dismissed flag on new progress", () => {
    wh.recordProgress(makeRecord({ position: 600 }));
    wh.dismiss("tv", 1000, 1, 1);
    assert.equal(wh.getProgress("tv", 1000, 1, 1)!.dismissed, true);
    wh.recordProgress(makeRecord({ position: 700 }));
    assert.equal(wh.getProgress("tv", 1000, 1, 1)!.dismissed, false);
  });

  it("stores movies with correct key", () => {
    wh.recordProgress(makeRecord({ tmdbId: 555, mediaType: "movie", season: undefined, episode: undefined, position: 1000, duration: 7200 }));
    const r = wh.getProgress("movie", 555);
    assert.ok(r);
    assert.equal(r.position, 1000);
  });
});

// ── getContinueWatching ─────────────────────────────────────────────

describe("WatchHistory.getContinueWatching", () => {
  it("returns unfinished items with >= 5 min watched", () => {
    wh.recordProgress(makeRecord({ tmdbId: 1, episode: 1, position: 300, duration: 2400 })); // 5 min ✓
    wh.recordProgress(makeRecord({ tmdbId: 2, episode: 2, position: 100, duration: 2400 })); // < 5 min ✗
    wh.recordProgress(makeRecord({ tmdbId: 3, episode: 3, position: 600, duration: 2400 })); // 10 min ✓
    const items = wh.getContinueWatching();
    const ids = items.map((i) => i.episode);
    assert.ok(ids.includes(1));
    assert.ok(ids.includes(3));
    assert.ok(!ids.includes(2));
  });

  it("excludes finished items (single finished episode shows as next-up, not in-progress)", () => {
    wh.recordProgress(makeRecord({ tmdbId: 8888, episode: 1, position: 2160, duration: 2400 })); // 90% = finished
    const cw = wh.getContinueWatching().filter((i) => i.tmdbId === 8888);
    // The finished episode itself shouldn't appear, but a "next up" (E2) will
    assert.ok(!cw.some((i) => i.episode === 1 && i.finished));
    // The next-up entry should be E2 with position 0
    if (cw.length > 0) {
      assert.equal(cw[0].episode, 2);
      assert.equal(cw[0].position, 0);
    }
  });

  it("excludes dismissed items", () => {
    wh.recordProgress(makeRecord({ position: 600, duration: 2400 }));
    wh.dismiss("tv", 1000, 1, 1);
    assert.equal(wh.getContinueWatching().length, 0);
  });

  it("sorts by most recently updated", async () => {
    wh.recordProgress(makeRecord({ tmdbId: 1, episode: 1, position: 600 }));
    await sleep(10);
    wh.recordProgress(makeRecord({ tmdbId: 2, episode: 2, position: 600 }));
    const items = wh.getContinueWatching();
    const first = items.find((i) => i.tmdbId === 1 || i.tmdbId === 2);
    assert.equal(first!.tmdbId, 2); // most recent first
  });

  it("includes 'next up' for series with all episodes finished", () => {
    wh.recordProgress(makeRecord({ tmdbId: 50, episode: 1, position: 2400, duration: 2400 })); // finished
    wh.recordProgress(makeRecord({ tmdbId: 50, episode: 2, position: 2400, duration: 2400 })); // finished
    wh.recordProgress(makeRecord({ tmdbId: 50, episode: 3, position: 2400, duration: 2400 })); // finished
    const items = wh.getContinueWatching();
    const nextUp = items.find((i) => i.tmdbId === 50);
    assert.ok(nextUp, "should have a next-up entry");
    assert.equal(nextUp!.episode, 4);
    assert.equal(nextUp!.position, 0);
    assert.equal(nextUp!.finished, false);
  });

  it("does not include 'next up' if series has an in-progress episode", () => {
    wh.recordProgress(makeRecord({ tmdbId: 50, episode: 1, position: 2400, duration: 2400 })); // finished
    wh.recordProgress(makeRecord({ tmdbId: 50, episode: 2, position: 600, duration: 2400 })); // in progress
    const items = wh.getContinueWatching();
    const forShow = items.filter((i) => i.tmdbId === 50);
    assert.equal(forShow.length, 1);
    assert.equal(forShow[0].episode, 2); // the in-progress one, not next-up
  });

  it("does not include 'next up' if last episode is dismissed", () => {
    wh.recordProgress(makeRecord({ tmdbId: 50, episode: 1, position: 2400, duration: 2400 }));
    wh.recordProgress(makeRecord({ tmdbId: 50, episode: 2, position: 2400, duration: 2400 }));
    wh.dismiss("tv", 50, 1, 2);
    const items = wh.getContinueWatching();
    assert.ok(!items.find((i) => i.tmdbId === 50));
  });

  it("limits to 20 items", () => {
    for (let i = 1; i <= 25; i++) {
      wh.recordProgress(makeRecord({ tmdbId: i, episode: i, position: 600 }));
    }
    assert.equal(wh.getContinueWatching().length, 20);
  });
});

// ── getResumePoint ──────────────────────────────────────────────────

describe("WatchHistory.getResumePoint", () => {
  it("returns null for unwatched series", () => {
    assert.equal(wh.getResumePoint(999, "tv"), null);
  });

  it("returns most recently watched unfinished episode", async () => {
    wh.recordProgress(makeRecord({ tmdbId: 10, episode: 1, position: 600 }));
    await sleep(10);
    wh.recordProgress(makeRecord({ tmdbId: 10, episode: 2, position: 800 }));
    const rp = wh.getResumePoint(10, "tv");
    assert.ok(rp);
    assert.equal(rp.episode, 2); // most recent
    assert.equal(rp.position, 800);
  });

  it("returns next episode when all recorded are finished", () => {
    wh.recordProgress(makeRecord({ tmdbId: 10, episode: 1, position: 2400, duration: 2400 }));
    wh.recordProgress(makeRecord({ tmdbId: 10, episode: 2, position: 2400, duration: 2400 }));
    wh.recordProgress(makeRecord({ tmdbId: 10, episode: 3, position: 2400, duration: 2400 }));
    const rp = wh.getResumePoint(10, "tv");
    assert.ok(rp);
    assert.equal(rp.season, 1);
    assert.equal(rp.episode, 4);
    assert.equal(rp.position, 0);
  });

  it("resumes most recent unfinished even if earlier episodes are also unfinished", async () => {
    // Watch E1 first, then E3 — E3 is more recent
    wh.recordProgress(makeRecord({ tmdbId: 10, episode: 1, position: 600 }));
    await sleep(10);
    wh.recordProgress(makeRecord({ tmdbId: 10, episode: 3, position: 400 }));
    const rp = wh.getResumePoint(10, "tv");
    assert.ok(rp);
    assert.equal(rp.episode, 3);
  });

  it("returns movie position if unfinished", () => {
    wh.recordProgress(makeRecord({ tmdbId: 77, mediaType: "movie", season: undefined, episode: undefined, position: 3600, duration: 7200 }));
    const rp = wh.getResumePoint(77, "movie");
    assert.ok(rp);
    assert.equal(rp.position, 3600);
  });

  it("returns null for finished movie", () => {
    wh.recordProgress(makeRecord({ tmdbId: 77, mediaType: "movie", season: undefined, episode: undefined, position: 7000, duration: 7200 }));
    assert.equal(wh.getResumePoint(77, "movie"), null);
  });

  it("updates after marking episodes watched", () => {
    // Mark E1, E2, E3 as watched
    for (let i = 1; i <= 3; i++) {
      wh.recordProgress(makeRecord({ tmdbId: 10, episode: i, position: 2400, duration: 2400 }));
    }
    const rp = wh.getResumePoint(10, "tv");
    assert.ok(rp);
    assert.equal(rp.episode, 4);

    // Now mark E2 as unwatched
    wh.recordProgress(makeRecord({ tmdbId: 10, episode: 2, position: 0, duration: 2400 }));
    const rp2 = wh.getResumePoint(10, "tv");
    assert.ok(rp2);
    // E2 is now unfinished with position 0 — but it's most recently updated
    // The most recently watched unfinished is E2
    assert.equal(rp2.episode, 2);
  });
});

// ── getSeriesProgress ───────────────────────────────────────────────

describe("WatchHistory.getSeriesProgress", () => {
  it("returns episodes sorted by season then episode", () => {
    wh.recordProgress(makeRecord({ tmdbId: 10, season: 2, episode: 1, position: 600 }));
    wh.recordProgress(makeRecord({ tmdbId: 10, season: 1, episode: 3, position: 600 }));
    wh.recordProgress(makeRecord({ tmdbId: 10, season: 1, episode: 1, position: 600 }));
    const eps = wh.getSeriesProgress(10);
    assert.equal(eps.length, 3);
    assert.equal(eps[0].season, 1);
    assert.equal(eps[0].episode, 1);
    assert.equal(eps[1].season, 1);
    assert.equal(eps[1].episode, 3);
    assert.equal(eps[2].season, 2);
    assert.equal(eps[2].episode, 1);
  });

  it("returns empty array for unknown series", () => {
    assert.deepEqual(wh.getSeriesProgress(999), []);
  });

  it("does not include movies", () => {
    wh.recordProgress(makeRecord({ tmdbId: 10, mediaType: "movie", season: undefined, episode: undefined, position: 600 }));
    assert.deepEqual(wh.getSeriesProgress(10), []);
  });
});

// ── getRecentlyWatched ──────────────────────────────────────────────

describe("WatchHistory.getRecentlyWatched", () => {
  it("deduplicates TV episodes by series", () => {
    wh.recordProgress(makeRecord({ tmdbId: 10, episode: 1, position: 600 }));
    wh.recordProgress(makeRecord({ tmdbId: 10, episode: 2, position: 600 }));
    wh.recordProgress(makeRecord({ tmdbId: 20, episode: 1, position: 600 }));
    const items = wh.getRecentlyWatched();
    const tmdbIds = items.map((i) => i.tmdbId);
    assert.equal(tmdbIds.filter((id) => id === 10).length, 1); // only one entry for show 10
    assert.ok(tmdbIds.includes(20));
  });

  it("excludes items with < 5 min watched", () => {
    wh.recordProgress(makeRecord({ position: 100 }));
    assert.equal(wh.getRecentlyWatched().length, 0);
  });
});

// ── dismiss ─────────────────────────────────────────────────────────

describe("WatchHistory.dismiss", () => {
  it("sets dismissed flag without deleting data", () => {
    wh.recordProgress(makeRecord({ position: 600 }));
    wh.dismiss("tv", 1000, 1, 1);
    const r = wh.getProgress("tv", 1000, 1, 1);
    assert.ok(r);
    assert.equal(r.dismissed, true);
    assert.equal(r.position, 600); // data preserved
  });

  it("only dismisses the specific episode", () => {
    wh.recordProgress(makeRecord({ tmdbId: 10, episode: 1, position: 600 }));
    wh.recordProgress(makeRecord({ tmdbId: 10, episode: 2, position: 600 }));
    wh.dismiss("tv", 10, 1, 1);
    assert.equal(wh.getProgress("tv", 10, 1, 1)!.dismissed, true);
    // Episode 2 should not be dismissed (dismissed is false because recordProgress sets it)
    assert.equal(wh.getProgress("tv", 10, 1, 2)!.dismissed, false);
  });

  it("no-op for nonexistent record", () => {
    wh.dismiss("tv", 999, 1, 1); // should not throw
  });
});
