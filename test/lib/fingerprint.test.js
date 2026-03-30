import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { popcount32, matchScore, crossCorrelate, extractFingerprint } from "../../lib/fingerprint.js";

// Simple LCG to generate pseudo-random 32-bit values for fingerprint test data.
// Real fpcalc fingerprints are pseudo-random 32-bit integers; small sequential
// integers cluster in the lower bits and produce spurious bit-level matches.
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
    const uniqueA = lcgArr(0xDEADBEEF, 30);
    const uniqueB = lcgArr(0xCAFEBABE, 60);
    const fpA = [...uniqueA, ...intro];
    const fpB = [...uniqueB, ...intro];
    const result = crossCorrelate(fpA, fpB);
    assert.ok(result, "should find a match");
    assert.equal(result.offsetA, 30);
    assert.equal(result.offsetB, 60);
    assert.equal(result.duration, 90);
    assert.ok(result.score > 0.9);
  });

  it("returns null for completely different arrays", () => {
    const fpA = lcgArr(0x11111111, 120);
    const fpB = lcgArr(0x22222222, 120);
    const result = crossCorrelate(fpA, fpB);
    assert.equal(result, null);
  });

  it("rejects match shorter than MIN_INTRO_SECS (30s)", () => {
    const intro = lcgArr(0x55667788, 20);
    const uniqueA = lcgArr(0x33333333, 100);
    const uniqueB = lcgArr(0x44444444, 100);
    const noiseA = lcgArr(0x55555555, 80);
    const noiseB = lcgArr(0x66666666, 80);
    const fpA = [...uniqueA, ...intro, ...noiseA];
    const fpB = [...uniqueB, ...intro, ...noiseB];
    const result = crossCorrelate(fpA, fpB);
    assert.equal(result, null);
  });

  it("rejects match longer than MAX_INTRO_SECS (180s)", () => {
    const intro = lcgArr(0x99AABBCC, 200);
    const uniqueA = lcgArr(0x77777777, 50);
    const uniqueB = lcgArr(0x88888888, 50);
    const fpA = [...uniqueA, ...intro];
    const fpB = [...uniqueB, ...intro];
    const result = crossCorrelate(fpA, fpB);
    assert.equal(result, null);
  });

  it("rejects match starting after MAX_INTRO_START (600s)", () => {
    const intro = lcgArr(0xDDEEFF00, 90);
    const uniqueA = lcgArr(0xAAAAAAAA, 610);
    const uniqueB = lcgArr(0xBBBBBBBB, 610);
    const fpA = [...uniqueA, ...intro];
    const fpB = [...uniqueB, ...intro];
    const result = crossCorrelate(fpA, fpB);
    assert.equal(result, null);
  });
});

describe("extractFingerprint", () => {
  it("rejects when fpcalc is not found", async () => {
    await assert.rejects(
      () => extractFingerprint("/nonexistent/file.mkv"),
      (err) => err.message.includes("fpcalc") || err.code === "ENOENT"
    );
  });
});
