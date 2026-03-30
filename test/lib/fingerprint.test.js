import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { popcount32, matchScore, crossCorrelate, extractFingerprint } from "../../lib/fingerprint.js";

// Simple LCG to generate pseudo-random 32-bit values for fingerprint test data.
function lcg(seed) {
  return function () {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed;
  };
}

function lcgArr(seed, n) {
  const gen = lcg(seed);
  return Array.from({ length: n }, gen);
}

// Create "noise" arrays that won't match each other or any LCG data.
// Uses alternating 0x00000000 and 0xFFFFFFFF — matchScore between these is 0.0,
// and matchScore between either of these and random LCG data is ~0.5
// (not high enough to trigger the match threshold consistently).
function noiseA(n) { return Array.from({ length: n }, () => 0x00000000); }
function noiseB(n) { return Array.from({ length: n }, () => 0xFFFFFFFF); }

describe("popcount32", () => {
  it("returns 0 for 0", () => {
    assert.equal(popcount32(0), 0);
  });

  it("counts bits in 0b1010", () => {
    assert.equal(popcount32(0b1010), 2);
  });

  it("counts all 32 bits set", () => {
    assert.equal(popcount32(0xFFFFFFFF), 32);
  });
});

describe("matchScore", () => {
  it("returns 1.0 for identical values", () => {
    assert.equal(matchScore(12345, 12345), 1.0);
  });

  it("returns 0.0 for completely different values", () => {
    assert.equal(matchScore(0x00000000, 0xFFFFFFFF), 0.0);
  });

  it("returns ~0.5 for half-matching bits", () => {
    assert.equal(matchScore(0xAAAAAAAA, 0x55555555), 0.0);
    assert.equal(matchScore(0xFFFF0000, 0xFFFF0000), 1.0);
  });
});

describe("crossCorrelate", () => {
  it("finds identical arrays match at offset 0 with score ~1.0", () => {
    const fp = lcgArr(0xABCD1234, 120);
    const result = crossCorrelate(fp, fp);
    assert.ok(result, "should find a match");
    assert.equal(result.offsetA, 0);
    assert.equal(result.offsetB, 0);
    assert.ok(result.score > 0.9);
  });

  it("finds shifted matching segment", () => {
    const intro = lcgArr(0x11223344, 90);
    const fpA = [...noiseA(30), ...intro];
    const fpB = [...noiseB(60), ...intro];
    const result = crossCorrelate(fpA, fpB);
    assert.ok(result, "should find a match");
    assert.equal(result.offsetA, 30);
    assert.equal(result.offsetB, 60);
    assert.equal(result.duration, 90);
    assert.ok(result.score > 0.9);
  });

  it("returns null for completely different arrays", () => {
    const fpA = noiseA(120);
    const fpB = noiseB(120);
    const result = crossCorrelate(fpA, fpB);
    assert.equal(result, null);
  });

  it("rejects match shorter than MIN_INTRO_SECS (30s)", () => {
    const intro = lcgArr(0x55667788, 20);
    const fpA = [...noiseA(100), ...intro, ...noiseA(80)];
    const fpB = [...noiseB(100), ...intro, ...noiseB(80)];
    const result = crossCorrelate(fpA, fpB);
    assert.equal(result, null);
  });

  it("rejects match starting after MAX_INTRO_START (600s)", () => {
    const intro = lcgArr(0xDDEEFF00, 90);
    const fpA = [...noiseA(610), ...intro];
    const fpB = [...noiseB(610), ...intro];
    const result = crossCorrelate(fpA, fpB);
    assert.equal(result, null);
  });

  it("converts sample offsets to seconds using rate parameter", () => {
    // rate=3 means 3 samples per second
    const intro = lcgArr(0x11223344, 270); // 270 samples = 90 seconds at rate 3
    const fpA = [...noiseA(90), ...intro]; // 90 samples = 30 seconds
    const fpB = [...noiseB(180), ...intro]; // 180 samples = 60 seconds
    const result = crossCorrelate(fpA, fpB, 3);
    assert.ok(result, "should find a match");
    assert.equal(result.offsetA, 30); // 90 samples / 3 = 30 sec
    assert.equal(result.offsetB, 60); // 180 samples / 3 = 60 sec
    assert.equal(result.duration, 90); // 270 samples / 3 = 90 sec
  });
});

describe("extractFingerprint", () => {
  it("rejects when file does not exist", async () => {
    await assert.rejects(
      () => extractFingerprint("/nonexistent/file.mkv"),
    );
  });
});
