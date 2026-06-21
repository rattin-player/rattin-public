import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { playbackKey, shouldRestorePosition } from "../src/lib/playback-position.js";

describe("playbackKey", () => {
  it("builds key from infoHash and fileIndex", () => {
    assert.equal(playbackKey("abc123", "0"), "playback:abc123:0");
    assert.equal(playbackKey("def456", "3"), "playback:def456:3");
  });
});

describe("shouldRestorePosition", () => {
  it("returns true for a valid saved position", () => {
    assert.equal(shouldRestorePosition(120, 7200), true);
  });

  it("returns false when saved time is 0", () => {
    assert.equal(shouldRestorePosition(0, 7200), false);
  });

  it("returns false when saved time is negative", () => {
    assert.equal(shouldRestorePosition(-5, 7200), false);
  });

  it("returns false when saved time is NaN", () => {
    assert.equal(shouldRestorePosition(NaN, 7200), false);
  });

  it("returns false when saved time is within 30s of the end", () => {
    // Movie is 7200s, saved at 7185 — too close to the end
    assert.equal(shouldRestorePosition(7185, 7200), false);
  });

  it("returns true when saved time is 31s from the end", () => {
    assert.equal(shouldRestorePosition(7169, 7200), true);
  });

  it("returns false when duration is 0 (unknown)", () => {
    assert.equal(shouldRestorePosition(120, 0), false);
  });

  it("returns false when saved time exceeds duration", () => {
    assert.equal(shouldRestorePosition(8000, 7200), false);
  });

  it("returns false when saved time is under 10s (too short to bother)", () => {
    assert.equal(shouldRestorePosition(5, 7200), false);
    assert.equal(shouldRestorePosition(9, 7200), false);
  });

  it("returns true when saved time is exactly 10s", () => {
    assert.equal(shouldRestorePosition(10, 7200), true);
  });
});
