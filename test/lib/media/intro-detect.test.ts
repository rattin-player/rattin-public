import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { detectIntro, lookupExternal, lookupAniskipMarkers, _setExtractor, _setFetcher } from "../../../lib/media/intro-detect.js";

// Use `any` for mock fetcher/extractor to avoid matching the exact overloaded signatures
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = any;

// LCG for deterministic pseudo-random 32-bit values
function lcg(seed: number): () => number {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
}

function lcgArr(seed: number, n: number): number[] {
  const gen = lcg(seed);
  return Array.from({ length: n }, gen);
}

// Noise arrays that won't match LCG data or each other
function noiseA(n: number): number[] { return Array.from({ length: n }, () => 0x00000000); }
function noiseB(n: number): number[] { return Array.from({ length: n }, () => 0xFFFFFFFF); }

describe("detectIntro", () => {
  beforeEach(() => {
    _setExtractor(null);
  });

  it("returns timestamps when two fingerprints have matching segment", async () => {
    const intro = lcgArr(0x11223344, 90);
    const fpA = [...noiseA(40), ...intro];
    const fpB = [...noiseB(70), ...intro];

    let callCount = 0;
    _setExtractor((async () => {
      callCount++;
      return callCount === 1 ? fpA : fpB;
    }) as AnyFn);

    const result = await detectIntro(["/fake/ep1.mkv", "/fake/ep2.mkv"]);
    assert.ok(result);
    assert.equal(result!.intro_start, 40);
    assert.equal(result!.intro_end, 130);
    assert.ok(result!.score > 0.9);
  });

  it("returns null when fingerprints do not match", async () => {
    let callCount = 0;
    _setExtractor((async () => {
      callCount++;
      // Return bitwise-opposite arrays — guaranteed 0.0 matchScore
      return callCount === 1 ? noiseA(120) : noiseB(120);
    }) as AnyFn);

    const result = await detectIntro(["/fake/ep1.mkv", "/fake/ep2.mkv"]);
    assert.equal(result, null);
  });

  it("returns null when fewer than 2 file paths provided", async () => {
    const result = await detectIntro(["/fake/ep1.mkv"]);
    assert.equal(result, null);
  });

  it("returns null when extractor throws", async () => {
    _setExtractor((async () => { throw new Error("fpcalc not found"); }) as AnyFn);
    const result = await detectIntro(["/fake/ep1.mkv", "/fake/ep2.mkv"]);
    assert.equal(result, null);
  });
});

describe("lookupExternal", () => {
  beforeEach(() => {
    _setFetcher(null);
  });

  it("returns timestamps from AniSkip when Jikan resolves title", async () => {
    _setFetcher((async (url: string) => {
      if (url.includes("jikan.moe")) {
        return {
          ok: true,
          json: async () => ({ data: [{ mal_id: 21 }] }),
        };
      }
      if (url.includes("aniskip.com")) {
        return {
          ok: true,
          json: async () => ({
            found: true,
            results: [{
              interval: { startTime: 42.5, endTime: 132.0 },
              skipType: "op",
              episodeLength: 1420,
            }],
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    }) as AnyFn);

    const result = await lookupExternal("One Punch Man", 1, 1, 1420);
    assert.ok(result);
    assert.equal(result!.intro_start, 42.5);
    assert.equal(result!.intro_end, 132.0);
  });

  it("returns null when Jikan finds no results", async () => {
    _setFetcher((async () => ({
      ok: true,
      json: async () => ({ data: [] }),
    })) as AnyFn);

    const result = await lookupExternal("Nonexistent Show XYZ", 1, 1, 1400);
    assert.equal(result, null);
  });

  it("returns null when AniSkip has no data", async () => {
    _setFetcher((async (url: string) => {
      if (url.includes("jikan.moe")) {
        return { ok: true, json: async () => ({ data: [{ mal_id: 999 }] }) };
      }
      return { ok: true, json: async () => ({ found: false, results: [] }) };
    }) as AnyFn);

    const result = await lookupExternal("Some Show", 1, 1, 1400);
    assert.equal(result, null);
  });

  it("returns null when fetch throws", async () => {
    _setFetcher((async () => { throw new Error("network error"); }) as AnyFn);
    const result = await lookupExternal("Whatever", 1, 1, 1400);
    assert.equal(result, null);
  });
});

describe("lookupAniskipMarkers", () => {
  beforeEach(() => {
    _setFetcher(null);
  });

  it("returns OP and ED markers with episode length when AniSkip provides both", async () => {
    _setFetcher((async (url: string) => {
      if (url.includes("jikan.moe")) {
        return { ok: true, json: async () => ({ data: [{ mal_id: 42 }] }) };
      }
      return {
        ok: true,
        json: async () => ({
          found: true,
          results: [
            { interval: { startTime: 42, endTime: 132 }, skipType: "op", episodeLength: 1420 },
            { interval: { startTime: 1280, endTime: 1380 }, skipType: "ed", episodeLength: 1420 },
          ],
        }),
      };
    }) as AnyFn);

    const result = await lookupAniskipMarkers("Chainsaw Man", 3, 1420);
    assert.ok(result);
    assert.equal(result!.opStart, 42);
    assert.equal(result!.opEnd, 132);
    assert.equal(result!.edStart, 1280);
    assert.equal(result!.episodeLength, 1420);
    assert.equal(result!.resolution.malId, 42);
  });

  it("returns null when neither op nor ed is present", async () => {
    _setFetcher((async (url: string) => {
      if (url.includes("jikan.moe")) return { ok: true, json: async () => ({ data: [{ mal_id: 1 }] }) };
      return { ok: true, json: async () => ({ found: true, results: [] }) };
    }) as AnyFn);

    const result = await lookupAniskipMarkers("Whatever", 1, 1400);
    assert.equal(result, null);
  });

  it("returns null when MAL resolution fails", async () => {
    _setFetcher((async () => ({ ok: true, json: async () => ({ data: [] }) })) as AnyFn);
    const result = await lookupAniskipMarkers("Nonexistent", 1, 1400);
    assert.equal(result, null);
  });

  it("falls back to caller duration when AniSkip omits episodeLength", async () => {
    _setFetcher((async (url: string) => {
      if (url.includes("jikan.moe")) return { ok: true, json: async () => ({ data: [{ mal_id: 7 }] }) };
      return {
        ok: true,
        json: async () => ({
          found: true,
          results: [{ interval: { startTime: 10, endTime: 100 }, skipType: "op" }],
        }),
      };
    }) as AnyFn);

    const result = await lookupAniskipMarkers("Some Show", 1, 1400);
    assert.ok(result);
    assert.equal(result!.episodeLength, 1400);
  });

  describe("season-aware resolution", () => {
    it("queries Jikan with 'Title Season N' for S>1 and returns a different MAL ID", async () => {
      const queries: string[] = [];
      _setFetcher((async (url: string) => {
        if (url.includes("jikan.moe")) {
          const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
          queries.push(q);
          const malId = /Season 3/i.test(q) ? 99986 : 16498;
          const title = /Season 3/i.test(q) ? "Shingeki no Kyojin Season 3" : "Shingeki no Kyojin";
          return { ok: true, json: async () => ({ data: [{ mal_id: malId, title }] }) };
        }
        return {
          ok: true,
          json: async () => ({
            found: true,
            results: [
              { interval: { startTime: 30, endTime: 120 }, skipType: "op", episodeLength: 1420 },
              { interval: { startTime: 1300, endTime: 1400 }, skipType: "ed", episodeLength: 1420 },
            ],
          }),
        };
      }) as AnyFn);

      const result = await lookupAniskipMarkers("Attack on Titan S3 case", 15, 1420, 3);
      assert.ok(result);
      assert.equal(result!.resolution.malId, 99986);
      assert.match(result!.resolution.jikanQuery, /Season 3/);
      assert.equal(result!.resolution.seasonSpecific, true);
      assert.match(result!.resolution.aniskipUrl, /\/99986\/15/);
    });

    it("falls back to base title when seasoned Jikan query returns no results", async () => {
      const queries: string[] = [];
      _setFetcher((async (url: string) => {
        if (url.includes("jikan.moe")) {
          const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
          queries.push(q);
          if (/Season 2/i.test(q)) return { ok: true, json: async () => ({ data: [] }) };
          return { ok: true, json: async () => ({ data: [{ mal_id: 11111, title: "Base Show" }] }) };
        }
        return {
          ok: true,
          json: async () => ({
            found: true,
            results: [{ interval: { startTime: 10, endTime: 100 }, skipType: "op" }],
          }),
        };
      }) as AnyFn);

      const result = await lookupAniskipMarkers("Base fallback show", 1, 1400, 2);
      assert.ok(result);
      assert.equal(result!.resolution.malId, 11111);
      assert.equal(result!.resolution.seasonSpecific, false);
      assert.equal(queries.length, 2, "should try seasoned query then fallback");
    });

    it("returns resolution metadata on every successful call", async () => {
      _setFetcher((async (url: string) => {
        if (url.includes("jikan.moe")) {
          return { ok: true, json: async () => ({ data: [{ mal_id: 123, title: "Resolved Title" }] }) };
        }
        return {
          ok: true,
          json: async () => ({
            found: true,
            results: [{ interval: { startTime: 5, endTime: 90 }, skipType: "op", episodeLength: 1400 }],
          }),
        };
      }) as AnyFn);

      const result = await lookupAniskipMarkers("Metadata check", 4, 1400, 1);
      assert.ok(result);
      assert.equal(result!.resolution.malId, 123);
      assert.equal(result!.resolution.jikanTitle, "Resolved Title");
      assert.ok(result!.resolution.aniskipUrl.includes("skip-times/123/4"));
    });
  });
});
