import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMarkers } from "../../lib/media/episode-markers.js";

describe("computeMarkers — priority fall-through", () => {
  it("uses chapter markers when present", () => {
    const m = computeMarkers({
      bridgeHasChapterSupport: true,
      chapters: [
        { time: 0, title: "Intro" },
        { time: 90, title: "Episode" },
        { time: 1260, title: "Ending" },
      ],
      aniskip: null,
      learnedOutroOffset: null,
      fileDuration: 1380,
    });
    assert.equal(m.introStart, 0);
    assert.equal(m.introEnd, 90);
    assert.equal(m.outroStart, 1260);
    assert.equal(m.introSource, "chapter markers");
    assert.equal(m.outroSource, "chapter markers");
  });

  it("falls through to AniSkip when chapters absent", () => {
    const m = computeMarkers({
      bridgeHasChapterSupport: true,
      chapters: [],
      aniskip: { opStart: 20, opEnd: 110, edStart: 1300, episodeLength: 1380 },
      learnedOutroOffset: null,
      fileDuration: 1380,
    });
    assert.equal(m.introStart, 20);
    assert.equal(m.introEnd, 110);
    assert.equal(m.outroStart, 1300);
    assert.equal(m.introSource, "AniSkip · duration OK");
  });

  it("rejects AniSkip when duration mismatches > 30s", () => {
    const m = computeMarkers({
      bridgeHasChapterSupport: true,
      chapters: [],
      aniskip: { opStart: 20, opEnd: 110, edStart: 1300, episodeLength: 1380 },
      learnedOutroOffset: null,
      fileDuration: 1430,
    });
    assert.equal(m.introStart, null);
    assert.equal(m.outroStart, null);
    assert.equal(m.introSource, "AniSkip · duration mismatch");
  });

  it("uses learned outro offset as last resort", () => {
    const m = computeMarkers({
      bridgeHasChapterSupport: true,
      chapters: [],
      aniskip: null,
      learnedOutroOffset: { offset: 1295, sampleCount: 3 },
      fileDuration: 1380,
    });
    assert.equal(m.outroStart, 1295);
    assert.equal(m.outroSource, "learned outro offset");
  });

  it("attributes 'bridge missing' when bridge has no chapter support", () => {
    const m = computeMarkers({
      bridgeHasChapterSupport: false,
      chapters: [],
      aniskip: null,
      learnedOutroOffset: null,
      fileDuration: 1380,
    });
    assert.equal(m.introSource, "bridge missing chapter support");
  });

  it("accepts exactly 30s duration difference", () => {
    const m = computeMarkers({
      bridgeHasChapterSupport: true,
      chapters: [],
      aniskip: { opStart: 20, opEnd: 110, edStart: 1300, episodeLength: 1380 },
      learnedOutroOffset: null,
      fileDuration: 1410,
    });
    assert.equal(m.introStart, 20);
  });

  it("rejects AniSkip at 30.01s boundary (strict > 30 check)", () => {
    const m = computeMarkers({
      bridgeHasChapterSupport: true,
      chapters: [],
      aniskip: { opStart: 20, opEnd: 110, edStart: 1300, episodeLength: 1380 },
      learnedOutroOffset: null,
      fileDuration: 1410.01,
    });
    assert.equal(m.introStart, null);
    assert.equal(m.outroStart, null);
    assert.equal(m.introSource, "AniSkip · duration mismatch");
  });

  it("ignores chapter titled 'End of Part 1' (no ED false-positive)", () => {
    const m = computeMarkers({
      bridgeHasChapterSupport: true,
      chapters: [
        { time: 0, title: "Cold Open" },
        { time: 600, title: "End of Part 1" },
        { time: 1200, title: "Part 2" },
      ],
      aniskip: null,
      learnedOutroOffset: null,
      fileDuration: 1380,
    });
    assert.equal(m.outroStart, null);
  });

  it("ignores chapter titled 'Operation' (no OP false-positive)", () => {
    const m = computeMarkers({
      bridgeHasChapterSupport: true,
      chapters: [
        { time: 0, title: "Cold Open" },
        { time: 60, title: "Operation Blackout" },
        { time: 1200, title: "Ending" },
      ],
      aniskip: null,
      learnedOutroOffset: null,
      fileDuration: 1380,
    });
    assert.equal(m.introStart, null);
    assert.equal(m.outroStart, 1200);
  });
});
