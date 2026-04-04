import { describe, it } from "node:test";
import assert from "node:assert/strict";
import EventEmitter from "node:events";
import { findSeekOffset, getSeekByteRange, waitForPieces } from "../lib/media/seek-index.js";
import type { SeekEntry } from "../lib/types.js";

describe("findSeekOffset", () => {
  const index: SeekEntry[] = [
    { time: 0, offset: 0 },
    { time: 5, offset: 50000 },
    { time: 10, offset: 100000 },
    { time: 15, offset: 150000 },
    { time: 20, offset: 200000 },
  ];

  it("finds exact match", () => {
    const result = findSeekOffset(index, 10);
    assert.equal(result!.time, 10);
    assert.equal(result!.offset, 100000);
  });

  it("returns keyframe before target time", () => {
    const result = findSeekOffset(index, 12);
    assert.equal(result!.time, 10);
    assert.equal(result!.offset, 100000);
  });

  it("returns first keyframe for time before all", () => {
    const result = findSeekOffset(index, 0);
    assert.equal(result!.time, 0);
    assert.equal(result!.offset, 0);
  });

  it("returns last keyframe for time after all", () => {
    const result = findSeekOffset(index, 100);
    assert.equal(result!.time, 20);
    assert.equal(result!.offset, 200000);
  });

  it("returns null for empty index", () => {
    assert.equal(findSeekOffset([], 10), null);
  });

  it("returns null for null index", () => {
    assert.equal(findSeekOffset(null as unknown as SeekEntry[], 10), null);
  });

  it("works with single entry", () => {
    const result = findSeekOffset([{ time: 5, offset: 50000 }], 10);
    assert.equal(result!.time, 5);
    assert.equal(result!.offset, 50000);
  });

  it("handles time between first two entries", () => {
    const result = findSeekOffset(index, 3);
    assert.equal(result!.time, 0);
    assert.equal(result!.offset, 0);
  });
});

describe("getSeekByteRange", () => {
  it("returns correct byte range", () => {
    const seekPoint: SeekEntry = { time: 10, offset: 100000 };
    const result = getSeekByteRange(seekPoint, 50000000);
    assert.equal(result.byteStart, 100000);
    // BUFFER_SIZE is 10MB = 10485760
    assert.equal(result.byteEnd, 100000 + 10 * 1024 * 1024);
  });

  it("clamps byteEnd to file length", () => {
    const seekPoint: SeekEntry = { time: 10, offset: 100000 };
    const fileLength = 200000;
    const result = getSeekByteRange(seekPoint, fileLength);
    assert.equal(result.byteStart, 100000);
    assert.equal(result.byteEnd, fileLength - 1);
  });

  it("handles seek at start of file", () => {
    const seekPoint: SeekEntry = { time: 0, offset: 0 };
    const result = getSeekByteRange(seekPoint, 50000000);
    assert.equal(result.byteStart, 0);
    assert.equal(result.byteEnd, 10 * 1024 * 1024);
  });
});

// ── waitForPieces tests ──────────────────────────────────────────────

interface MockWaitTorrent extends EventEmitter {
  pieceLength: number;
  bitfield: { get: (i: number) => boolean };
  select(from: number, to: number, priority: number): void;
  deselect(from: number, to: number): void;
  critical(): void;
  _downloaded: Set<number>;
  _selections: Array<{ from: number; to: number; priority: number }>;
  _deselections: Array<{ from: number; to: number }>;
  markDownloaded(piece: number): void;
}

interface MockWaitFile {
  offset: number;
  length: number;
  select(): void;
  deselect(): void;
  _calls: { selectCount: number; deselectCount: number };
}

function mockTorrent(opts: { pieceLength?: number; downloaded?: number[] } = {}): MockWaitTorrent {
  const pieceLength = opts.pieceLength || 256 * 1024;
  const downloaded = new Set(opts.downloaded || []);
  const selections: Array<{ from: number; to: number; priority: number }> = [];
  const deselections: Array<{ from: number; to: number }> = [];
  const emitter = new EventEmitter();

  return Object.assign(emitter, {
    pieceLength,
    bitfield: { get: (i: number) => downloaded.has(i) },
    select: (from: number, to: number, priority: number) => selections.push({ from, to, priority }),
    deselect: (from: number, to: number) => deselections.push({ from, to }),
    critical: () => {},
    _downloaded: downloaded,
    _selections: selections,
    _deselections: deselections,
    markDownloaded(piece: number) {
      downloaded.add(piece);
      emitter.emit("verified", piece);
    },
  }) as MockWaitTorrent;
}

function mockFile(opts: { offset?: number; length?: number } = {}): MockWaitFile {
  const calls = { selectCount: 0, deselectCount: 0 };
  return {
    offset: opts.offset || 0,
    length: opts.length || 50 * 1024 * 1024,
    select: () => { calls.selectCount++; },
    deselect: () => { calls.deselectCount++; },
    _calls: calls,
  };
}

// Type aliases for cleaner cast expressions
type WaitTorrent = Parameters<typeof waitForPieces>[0];
type WaitFile = Parameters<typeof waitForPieces>[1];

describe("waitForPieces", () => {
  it("resolves immediately if all pieces are present", async () => {
    const torrent = mockTorrent({ downloaded: [0, 1, 2] });
    const file = mockFile();
    await waitForPieces(torrent as unknown as WaitTorrent, file as unknown as WaitFile, 0, 256 * 1024 * 3 - 1);
    // Should not have deselected/selected since pieces were already present
    assert.equal(file._calls.deselectCount, 0);
  });

  it("deselects file and selects seek range when pieces missing", async () => {
    const torrent = mockTorrent();
    const file = mockFile();

    // byteStart=0, byteEnd=262143 → piece 0 only (one piece, 256KB)
    const promise = waitForPieces(torrent as unknown as WaitTorrent, file as unknown as WaitFile, 0, 262143, 5000);

    // Should have deselected file and selected the seek range
    assert.equal(file._calls.deselectCount, 1, "file.deselect() should be called");
    assert.equal(torrent._selections.length, 1, "torrent.select() should be called for seek range");
    assert.equal(torrent._selections[0].from, 0);
    assert.equal(torrent._selections[0].to, 0);
    assert.equal(torrent._selections[0].priority, 5);

    // Simulate piece arriving
    torrent.markDownloaded(0);

    await promise;

    // After resolve: should restore file selection and deselect seek range
    assert.equal(file._calls.selectCount, 1, "file.select() should restore after resolve");
    assert.equal(torrent._deselections.length, 1, "seek range should be deselected after resolve");
  });

  it("restores file selection on timeout", async () => {
    const torrent = mockTorrent();
    const file = mockFile();

    await assert.rejects(
      () => waitForPieces(torrent as unknown as WaitTorrent, file as unknown as WaitFile, 0, 256 * 1024, 100),
      { message: "Piece download timeout" },
    );

    // Should restore file selection even on timeout
    assert.equal(file._calls.selectCount, 1, "file.select() should restore after timeout");
    assert.equal(torrent._deselections.length, 1, "seek range should be deselected after timeout");
  });

  it("calculates correct piece range from byte offsets", async () => {
    const torrent = mockTorrent({ pieceLength: 1024 });
    const file = mockFile({ offset: 2048, length: 10240 });

    // byteStart=1024, byteEnd=3071 → absolute 3072-5119 → pieces 3,4
    const promise = waitForPieces(torrent as unknown as WaitTorrent, file as unknown as WaitFile, 1024, 3071, 5000);

    assert.equal(torrent._selections[0].from, 3);
    assert.equal(torrent._selections[0].to, 4);

    torrent.markDownloaded(3);
    torrent.markDownloaded(4);
    await promise;
  });
});
