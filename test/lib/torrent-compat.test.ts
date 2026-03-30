import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getFileOffset, getFileEndPiece, hasPiece } from "../../lib/torrent-compat.js";

describe("getFileOffset", () => {
  it("returns file.offset when it is a valid number", () => {
    assert.equal(getFileOffset({ offset: 1024 } as Parameters<typeof getFileOffset>[0]), 1024);
  });
  it("returns 0 as valid offset", () => {
    assert.equal(getFileOffset({ offset: 0 } as Parameters<typeof getFileOffset>[0]), 0);
  });
  it("throws when offset is undefined", () => {
    assert.throws(() => getFileOffset({} as Parameters<typeof getFileOffset>[0]), /torrent-compat.*file\.offset/);
  });
  it("throws when offset is NaN", () => {
    assert.throws(() => getFileOffset({ offset: NaN } as Parameters<typeof getFileOffset>[0]), /torrent-compat/);
  });
});

describe("getFileEndPiece", () => {
  it("returns file._endPiece when valid", () => {
    assert.equal(getFileEndPiece({ _endPiece: 42 } as Parameters<typeof getFileEndPiece>[0]), 42);
  });
  it("throws when _endPiece is missing", () => {
    assert.throws(() => getFileEndPiece({} as Parameters<typeof getFileEndPiece>[0]), /torrent-compat.*_endPiece/);
  });
});

describe("hasPiece", () => {
  it("returns true when bitfield.get returns true", () => {
    const torrent = { bitfield: { get: (i: number) => i === 5 } };
    assert.equal(hasPiece(torrent as unknown as Parameters<typeof hasPiece>[0], 5), true);
    assert.equal(hasPiece(torrent as unknown as Parameters<typeof hasPiece>[0], 6), false);
  });
  it("throws when bitfield is missing", () => {
    assert.throws(() => hasPiece({} as Parameters<typeof hasPiece>[0], 0), /torrent-compat.*bitfield/);
  });
  it("throws when bitfield.get is not a function", () => {
    assert.throws(() => hasPiece({ bitfield: {} } as Parameters<typeof hasPiece>[0], 0), /torrent-compat.*bitfield/);
  });
});
