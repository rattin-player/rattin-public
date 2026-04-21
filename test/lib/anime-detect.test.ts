import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isAnime, _setTmdbFetcher } from "../../lib/media/anime-detect.js";
import { tmdbCache } from "../../lib/cache/cache.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = any;

describe("isAnime", () => {
  beforeEach(() => {
    tmdbCache.clear();
    _setTmdbFetcher(null);
  });

  it("returns true for JP origin with Animation genre", async () => {
    _setTmdbFetcher((async () => ({
      origin_country: ["JP"],
      genres: [{ id: 16, name: "Animation" }, { id: 10765, name: "Sci-Fi & Fantasy" }],
    })) as AnyFn);
    assert.equal(await isAnime("1429"), true);
  });

  it("returns false for JP origin without Animation genre", async () => {
    _setTmdbFetcher((async () => ({
      origin_country: ["JP"],
      genres: [{ id: 18, name: "Drama" }],
    })) as AnyFn);
    assert.equal(await isAnime("99"), false);
  });

  it("returns false for Animation genre but non-JP origin", async () => {
    _setTmdbFetcher((async () => ({
      origin_country: ["US"],
      genres: [{ id: 16, name: "Animation" }],
    })) as AnyFn);
    assert.equal(await isAnime("1234"), false);
  });

  it("returns false when tmdb fetch throws", async () => {
    _setTmdbFetcher((async () => { throw new Error("TMDB_API_KEY not set"); }) as AnyFn);
    assert.equal(await isAnime("1429"), false);
  });

  it("returns false on missing fields", async () => {
    _setTmdbFetcher((async () => ({})) as AnyFn);
    assert.equal(await isAnime("1"), false);
  });

  it("caches the result across calls", async () => {
    let calls = 0;
    _setTmdbFetcher((async () => {
      calls++;
      return { origin_country: ["JP"], genres: [{ id: 16, name: "Animation" }] };
    }) as AnyFn);
    assert.equal(await isAnime("5114"), true);
    assert.equal(await isAnime("5114"), true);
    assert.equal(calls, 1);
  });
});
