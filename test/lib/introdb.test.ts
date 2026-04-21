import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { lookupIntrodbMarkers, _setFetcher } from "../../lib/media/introdb.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = any;

describe("lookupIntrodbMarkers", () => {
  beforeEach(() => { _setFetcher(null); });

  it("returns intro and outro when both pass the submission floor", async () => {
    _setFetcher((async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        imdb_id: "tt0944947", season: 1, episode: 1,
        intro: { start_ms: 2500, end_ms: 58000, start_sec: 2.5, end_sec: 58, confidence: 0.9, submission_count: 5 },
        recap: null,
        outro: { start_ms: 1300000, end_ms: 1380000, start_sec: 1300, end_sec: 1380, confidence: 0.8, submission_count: 3 },
      }),
    })) as AnyFn);

    const r = await lookupIntrodbMarkers("tt0944947", 1, 1);
    assert.ok(r);
    assert.deepEqual(r!.intro, { startSec: 2.5, endSec: 58, confidence: 0.9, submissionCount: 5 });
    assert.deepEqual(r!.outro, { startSec: 1300, endSec: 1380, confidence: 0.8, submissionCount: 3 });
    assert.equal(r!.imdbId, "tt0944947");
  });

  it("drops segments below submission floor (intro kept, outro dropped)", async () => {
    _setFetcher((async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        intro: { start_sec: 10, end_sec: 40, confidence: 0.7, submission_count: 2 },
        recap: null,
        outro: { start_sec: 1200, end_sec: 1260, confidence: 0.5, submission_count: 1 },
      }),
    })) as AnyFn);

    const r = await lookupIntrodbMarkers("tt0944947", 1, 1);
    assert.ok(r);
    assert.ok(r!.intro);
    assert.equal(r!.outro, null);
  });

  it("returns null when no segments pass the floor", async () => {
    _setFetcher((async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        intro: { start_sec: 10, end_sec: 40, confidence: 0.5, submission_count: 1 },
        recap: null,
        outro: null,
      }),
    })) as AnyFn);

    const r = await lookupIntrodbMarkers("tt0944947", 1, 1);
    assert.equal(r, null);
  });

  it("returns null on 404", async () => {
    _setFetcher((async () => ({ ok: false, status: 404, json: async () => ({}) })) as AnyFn);
    assert.equal(await lookupIntrodbMarkers("tt0000000", 1, 1), null);
  });

  it("returns null on non-2xx", async () => {
    _setFetcher((async () => ({ ok: false, status: 500, json: async () => ({}) })) as AnyFn);
    assert.equal(await lookupIntrodbMarkers("tt0944947", 1, 1), null);
  });

  it("returns null on network error", async () => {
    _setFetcher((async () => { throw new Error("fetch failed"); }) as AnyFn);
    assert.equal(await lookupIntrodbMarkers("tt0944947", 1, 1), null);
  });

  it("ignores recap segment even when passing the floor", async () => {
    _setFetcher((async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        intro: null,
        recap: { start_sec: 0, end_sec: 30, confidence: 0.9, submission_count: 10 },
        outro: null,
      }),
    })) as AnyFn);

    // Only intro/outro count for the floor check; recap being present should not rescue the response.
    const r = await lookupIntrodbMarkers("tt0944947", 1, 1);
    assert.equal(r, null);
  });

  it("sends the expected URL", async () => {
    let capturedUrl = "";
    _setFetcher((async (url: string) => {
      capturedUrl = url;
      return { ok: false, status: 404, json: async () => ({}) };
    }) as AnyFn);
    await lookupIntrodbMarkers("tt0944947", 3, 7);
    assert.equal(capturedUrl, "https://api.introdb.app/segments?imdb_id=tt0944947&season=3&episode=7");
  });
});
