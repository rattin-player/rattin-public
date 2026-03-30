import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findSeekOffset, getSeekByteRange } from "../lib/seek-index.js";

describe("findSeekOffset", () => {
  const index = [
    { time: 0, offset: 0 },
    { time: 5, offset: 50000 },
    { time: 10, offset: 100000 },
    { time: 15, offset: 150000 },
    { time: 20, offset: 200000 },
  ];

  it("finds exact match", () => {
    const result = findSeekOffset(index, 10);
    assert.equal(result.time, 10);
    assert.equal(result.offset, 100000);
  });

  it("returns keyframe before target time", () => {
    const result = findSeekOffset(index, 12);
    assert.equal(result.time, 10);
    assert.equal(result.offset, 100000);
  });

  it("returns first keyframe for time before all", () => {
    const result = findSeekOffset(index, 0);
    assert.equal(result.time, 0);
    assert.equal(result.offset, 0);
  });

  it("returns last keyframe for time after all", () => {
    const result = findSeekOffset(index, 100);
    assert.equal(result.time, 20);
    assert.equal(result.offset, 200000);
  });

  it("returns null for empty index", () => {
    assert.equal(findSeekOffset([], 10), null);
  });

  it("returns null for null index", () => {
    assert.equal(findSeekOffset(null, 10), null);
  });

  it("works with single entry", () => {
    const result = findSeekOffset([{ time: 5, offset: 50000 }], 10);
    assert.equal(result.time, 5);
    assert.equal(result.offset, 50000);
  });

  it("handles time between first two entries", () => {
    const result = findSeekOffset(index, 3);
    assert.equal(result.time, 0);
    assert.equal(result.offset, 0);
  });
});

describe("getSeekByteRange", () => {
  it("returns correct byte range", () => {
    const seekPoint = { time: 10, offset: 100000 };
    const result = getSeekByteRange(seekPoint, 50000000);
    assert.equal(result.byteStart, 100000);
    // BUFFER_SIZE is 10MB = 10485760
    assert.equal(result.byteEnd, 100000 + 10 * 1024 * 1024);
  });

  it("clamps byteEnd to file length", () => {
    const seekPoint = { time: 10, offset: 100000 };
    const fileLength = 200000;
    const result = getSeekByteRange(seekPoint, fileLength);
    assert.equal(result.byteStart, 100000);
    assert.equal(result.byteEnd, fileLength - 1);
  });

  it("handles seek at start of file", () => {
    const seekPoint = { time: 0, offset: 0 };
    const result = getSeekByteRange(seekPoint, 50000000);
    assert.equal(result.byteStart, 0);
    assert.equal(result.byteEnd, 10 * 1024 * 1024);
  });
});
