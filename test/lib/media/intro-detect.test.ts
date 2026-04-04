import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { detectIntro, lookupExternal, _setExtractor, _setFetcher } from "../../../lib/media/intro-detect.js";

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
