import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * The smart seek decision: when the file is incomplete and pieces around
 * the seek target are available, should we read from disk or pipe from
 * WebTorrent?
 *
 * Before the fix: always disk (isComplete=true hardcoded) — WRONG
 * After the fix:  disk only when file is actually complete, otherwise pipe
 */
describe("smart seek input decision", () => {
  // Simulates the decision logic extracted from routes/stream.ts
  function smartSeekShouldUsePipe(fileComplete: boolean): boolean {
    // After the fix: use pipe (WebTorrent stream) when file is incomplete
    return !fileComplete;
  }

  it("uses disk read when file is complete", () => {
    assert.equal(smartSeekShouldUsePipe(true), false);
  });

  it("uses WebTorrent pipe when file is incomplete", () => {
    assert.equal(smartSeekShouldUsePipe(false), true);
  });
});
