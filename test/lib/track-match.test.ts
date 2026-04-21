import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeLang, pickAudioTrack, pickSubtitleTrack } from "../../lib/media/track-match.js";

describe("normalizeLang", () => {
  it("maps Japanese aliases to ja", () => {
    assert.equal(normalizeLang("jpn"), "ja");
    assert.equal(normalizeLang("ja"), "ja");
    assert.equal(normalizeLang("Japanese"), "ja");
    assert.equal(normalizeLang("日本語"), "ja");
    assert.equal(normalizeLang("JP"), "ja");
  });
  it("maps English aliases to en", () => {
    assert.equal(normalizeLang("eng"), "en");
    assert.equal(normalizeLang("en-US"), "en");
  });
  it("returns unknown codes lowercased", () => {
    assert.equal(normalizeLang("ger"), "ger");
  });
});

describe("pickAudioTrack", () => {
  const tracks = [
    { index: 1, lang: "eng", title: "English 5.1", codec: "eac3", channels: 6 },
    { index: 2, lang: "jpn", title: "Original Japanese 2.0", codec: "aac", channels: 2 },
    { index: 3, lang: "jpn", title: "Commentary", codec: "aac", channels: 2 },
  ];
  it("picks by persisted language + title", () => {
    const idx = pickAudioTrack(tracks, { lang: "ja", title: "Original Japanese 2.0" }, "ja");
    assert.equal(idx, 2);
  });
  it("falls back to default language when no persisted pick", () => {
    const idx = pickAudioTrack(tracks, null, "ja");
    assert.equal(idx, 2);
  });
  it("deprioritizes 'commentary' in title", () => {
    const commentaryOnly = [tracks[2]];
    const idx = pickAudioTrack(commentaryOnly, null, "ja");
    assert.equal(idx, 3);
  });
  it("returns -1 when no match and no default possible", () => {
    const idx = pickAudioTrack([], null, "ja");
    assert.equal(idx, -1);
  });
});

describe("pickSubtitleTrack", () => {
  const subs = [
    { index: 1, lang: "eng", title: "English (Full)", forced: false },
    { index: 2, lang: "eng", title: "English (Signs & Songs)", forced: true },
    { index: 3, lang: "spa", title: "Spanish", forced: false },
  ];
  it("prefers full dialog over forced/signs", () => {
    const idx = pickSubtitleTrack(subs, null, "en");
    assert.equal(idx, 1);
  });
  it("picks exact title match when persisted", () => {
    const idx = pickSubtitleTrack(subs, { lang: "en", title: "English (Signs & Songs)" }, "en");
    assert.equal(idx, 2);
  });
  it("returns -1 when no matching language", () => {
    const idx = pickSubtitleTrack(subs, null, "ja");
    assert.equal(idx, -1);
  });
});
