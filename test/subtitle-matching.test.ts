import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractEpisodeId, subtitleMatchesVideo } from "../src/lib/useSubtitles.js";

describe("extractEpisodeId", () => {
  it("extracts S01E03 format", () => {
    assert.equal(extractEpisodeId("Show.S01E03.720p.mkv"), "S01E03");
    assert.equal(extractEpisodeId("show.s2e10.web.mkv"), "S2E10");
  });

  it("extracts EP03 format", () => {
    assert.equal(extractEpisodeId("Show EP03.mkv"), "E03");
    assert.equal(extractEpisodeId("Show.E12.mkv"), "E12");
  });

  it("extracts bare number patterns (anime style)", () => {
    assert.equal(extractEpisodeId("Show - 03.mkv"), "E03");
    assert.equal(extractEpisodeId("Show.03.mkv"), "E03");
  });

  it("ignores year-like numbers", () => {
    assert.equal(extractEpisodeId("Movie.2024.mkv"), null);
  });

  it("returns null for no match", () => {
    assert.equal(extractEpisodeId("Movie.mkv"), null);
  });
});

describe("subtitleMatchesVideo", () => {
  it("matches exact base name", () => {
    assert.ok(subtitleMatchesVideo("movie.srt", "movie.mkv"));
  });

  it("matches sub with language suffix", () => {
    assert.ok(subtitleMatchesVideo("movie.en.srt", "movie.mkv"));
    assert.ok(subtitleMatchesVideo("movie.eng.srt", "movie.mkv"));
  });

  it("matches by episode in season pack", () => {
    assert.ok(subtitleMatchesVideo(
      "Subs/Show.S01E03.eng.srt",
      "Show.S01E03.720p.WEB.mkv",
    ));
  });

  it("rejects different episodes", () => {
    assert.ok(!subtitleMatchesVideo(
      "Subs/Show.S01E04.eng.srt",
      "Show.S01E03.720p.WEB.mkv",
    ));
  });

  it("rejects unrelated files", () => {
    assert.ok(!subtitleMatchesVideo("other-show.srt", "movie.mkv"));
  });

  it("matches with subdirectory paths", () => {
    assert.ok(subtitleMatchesVideo(
      "Season 1/Subs/Show.S01E05.eng.srt",
      "Season 1/Show.S01E05.720p.mkv",
    ));
  });
});
