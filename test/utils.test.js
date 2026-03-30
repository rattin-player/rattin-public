import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatTime, formatEta, ratingColor } from "../src/lib/utils.js";

describe("formatBytes", () => {
  it("formats zero", () => {
    assert.equal(formatBytes(0), "0 B");
  });

  it("formats bytes", () => {
    assert.equal(formatBytes(500), "500 B");
  });

  it("formats kilobytes", () => {
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(1536), "1.5 KB");
  });

  it("formats megabytes", () => {
    assert.equal(formatBytes(1048576), "1.0 MB");
  });

  it("formats gigabytes", () => {
    assert.equal(formatBytes(1073741824), "1.0 GB");
  });
});

describe("formatTime", () => {
  it("formats zero", () => {
    assert.equal(formatTime(0), "0:00");
  });

  it("formats seconds only", () => {
    assert.equal(formatTime(45), "0:45");
  });

  it("formats minutes and seconds", () => {
    assert.equal(formatTime(125), "2:05");
  });

  it("formats hours", () => {
    assert.equal(formatTime(3661), "1:01:01");
  });

  it("pads seconds and minutes", () => {
    assert.equal(formatTime(3601), "1:00:01");
  });

  it("handles NaN", () => {
    assert.equal(formatTime(NaN), "0:00");
  });

  it("handles Infinity", () => {
    assert.equal(formatTime(Infinity), "0:00");
  });

  it("handles null/undefined", () => {
    assert.equal(formatTime(null), "0:00");
    assert.equal(formatTime(undefined), "0:00");
  });
});

describe("formatEta", () => {
  it("formats sub-minute", () => {
    assert.equal(formatEta(30), "30s");
    assert.equal(formatEta(1), "1s");
  });

  it("formats minutes", () => {
    assert.equal(formatEta(120), "2m");
    assert.equal(formatEta(300), "5m");
  });

  it("formats hours and minutes", () => {
    assert.equal(formatEta(3660), "1h 1m");
    assert.equal(formatEta(7200), "2h 0m");
  });

  it("handles edge cases", () => {
    assert.equal(formatEta(0), "\u2014");
    assert.equal(formatEta(NaN), "\u2014");
    assert.equal(formatEta(null), "\u2014");
    assert.equal(formatEta(Infinity), "\u2014");
  });
});

describe("ratingColor", () => {
  it("returns green for high ratings", () => {
    assert.equal(ratingColor(7), "var(--green)");
    assert.equal(ratingColor(10), "var(--green)");
  });

  it("returns yellow for medium ratings", () => {
    assert.equal(ratingColor(5), "var(--yellow)");
    assert.equal(ratingColor(6.9), "var(--yellow)");
  });

  it("returns red for low ratings", () => {
    assert.equal(ratingColor(4.9), "var(--red)");
    assert.equal(ratingColor(0), "var(--red)");
  });
});
