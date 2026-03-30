import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreTorrent, parseTags, matchEpisodePattern,
  findEpisodeFile, findLargestVideoFile,
} from "../lib/torrent-scoring.js";

describe("parseTags", () => {
  it("detects resolution", () => {
    assert.deepEqual(parseTags("Movie.2160p.BluRay"), ["4K", "BluRay"]);
    assert.ok(parseTags("Movie.1080p.WEB-DL").includes("1080p"));
    assert.ok(parseTags("Movie.720p.HDTV").includes("720p"));
    assert.ok(parseTags("Movie.480p.WEBRip").includes("480p"));
  });

  it("detects source", () => {
    assert.ok(parseTags("Movie.BluRay.x264").includes("BluRay"));
    assert.ok(parseTags("Movie.Blu-ray.x264").includes("BluRay"));
    assert.ok(parseTags("Movie.WEB-DL").includes("WEB-DL"));
    assert.ok(parseTags("Movie.WEBRip").includes("WEBRip"));
    assert.ok(parseTags("Movie.BDRip").includes("BDRip"));
    assert.ok(parseTags("Movie.HDTV").includes("HDTV"));
    assert.ok(parseTags("Movie.CAM").includes("CAM"));
    assert.ok(parseTags("Movie.HDCAM").includes("CAM"));
  });

  it("detects codec", () => {
    assert.ok(parseTags("Movie.x265.1080p").includes("HEVC"));
    assert.ok(parseTags("Movie.HEVC.1080p").includes("HEVC"));
    assert.ok(parseTags("Movie.x264.720p").includes("x264"));
    assert.ok(parseTags("Movie.AV1.1080p").includes("AV1"));
  });

  it("detects audio", () => {
    assert.ok(parseTags("Movie.Atmos.1080p").includes("Atmos"));
    assert.ok(parseTags("Movie.DTS.1080p").includes("DTS"));
    assert.ok(parseTags("Movie.DD5.1.1080p").includes("5.1"));
    assert.ok(parseTags("Movie.EAC3.1080p").includes("5.1"));
  });

  it("detects container", () => {
    assert.ok(parseTags("Movie.1080p.file.mp4").includes("MP4"));
    assert.ok(parseTags("Movie.1080p.file.mkv").includes("MKV"));
  });

  it("detects extras", () => {
    assert.ok(parseTags("Movie.Remux.1080p").includes("Remux"));
    assert.ok(parseTags("Movie.HDR10+.2160p").includes("HDR10+"));
    assert.ok(parseTags("Movie.HDR.2160p").includes("HDR"));
  });

  it("handles combination of tags", () => {
    const tags = parseTags("Movie.2024.2160p.BluRay.Remux.HEVC.Atmos.file.mkv");
    assert.ok(tags.includes("4K"));
    assert.ok(tags.includes("BluRay"));
    assert.ok(tags.includes("HEVC"));
    assert.ok(tags.includes("Atmos"));
    assert.ok(tags.includes("MKV"));
    assert.ok(tags.includes("Remux"));
  });

  it("returns empty for untagged names", () => {
    assert.deepEqual(parseTags("some random file"), []);
  });
});

describe("scoreTorrent", () => {
  const makeTorrent = (name, seeders = 10) => ({ name, seeders });

  it("returns -1 when first title word is missing", () => {
    assert.equal(scoreTorrent(makeTorrent("Unrelated.Movie.2024"), "Inception", 2010), -1);
  });

  it("returns -1 for zero seeders", () => {
    assert.equal(scoreTorrent(makeTorrent("Inception.2010.1080p", 0), "Inception", 2010), -1);
  });

  it("scores higher with more title words matched", () => {
    const full = scoreTorrent(makeTorrent("The.Dark.Knight.2008.1080p"), "The Dark Knight", 2008);
    const partial = scoreTorrent(makeTorrent("The.Other.Movie.2008.1080p"), "The Dark Knight", 2008);
    assert.ok(full > partial);
  });

  it("adds year bonus", () => {
    const withYear = scoreTorrent(makeTorrent("Inception.2010.1080p"), "Inception", 2010);
    const noYear = scoreTorrent(makeTorrent("Inception.1080p"), "Inception", 2010);
    assert.ok(withYear > noYear);
  });

  it("scores 1080p higher than 720p", () => {
    const hd = scoreTorrent(makeTorrent("Inception.2010.1080p"), "Inception", 2010);
    const sd = scoreTorrent(makeTorrent("Inception.2010.720p"), "Inception", 2010);
    assert.ok(hd > sd);
  });

  it("penalizes CAM quality heavily", () => {
    const good = scoreTorrent(makeTorrent("Inception.2010.1080p.BluRay"), "Inception", 2010);
    const cam = scoreTorrent(makeTorrent("Inception.2010.CAM"), "Inception", 2010);
    assert.ok(good > cam);
  });

  it("prefers MP4 over MKV", () => {
    const mp4 = scoreTorrent(makeTorrent("Inception.2010.1080p.file.mp4"), "Inception", 2010);
    const mkv = scoreTorrent(makeTorrent("Inception.2010.1080p.file.mkv"), "Inception", 2010);
    assert.ok(mp4 > mkv);
  });

  it("gives seeder bonus (logarithmic)", () => {
    const few = scoreTorrent(makeTorrent("Inception.2010.1080p", 2), "Inception", 2010);
    const many = scoreTorrent(makeTorrent("Inception.2010.1080p", 1000), "Inception", 2010);
    assert.ok(many > few);
  });

  it("caps seeder bonus at 30", () => {
    const big = scoreTorrent(makeTorrent("Inception.2010.1080p", 100000), "Inception", 2010);
    const huge = scoreTorrent(makeTorrent("Inception.2010.1080p", 10000000), "Inception", 2010);
    // Both should be capped, so difference should be 0 or very small
    assert.ok(Math.abs(big - huge) < 1);
  });

  it("adds source quality bonus", () => {
    const bluray = scoreTorrent(makeTorrent("Inception.2010.1080p.BluRay"), "Inception", 2010);
    const bare = scoreTorrent(makeTorrent("Inception.2010.1080p"), "Inception", 2010);
    assert.ok(bluray > bare);
  });
});

describe("matchEpisodePattern", () => {
  it("matches S01E05 format", () => {
    assert.ok(matchEpisodePattern("Show.S01E05.720p.mkv", 1, 5));
  });

  it("matches S1E5 format", () => {
    assert.ok(matchEpisodePattern("Show.S1E5.720p.mkv", 1, 5));
  });

  it("matches 1x05 format", () => {
    assert.ok(matchEpisodePattern("Show.1x05.720p.mkv", 1, 5));
  });

  it("matches .E05 format", () => {
    assert.ok(matchEpisodePattern("Show.E05.720p.mkv", 1, 5));
  });

  it("matches Episode.05 format", () => {
    assert.ok(matchEpisodePattern("Show.Episode.05.720p.mkv", 1, 5));
  });

  it("matches Episode 5 format", () => {
    assert.ok(matchEpisodePattern("Show Episode 5 720p.mkv", 1, 5));
  });

  it("matches Ep05 format", () => {
    assert.ok(matchEpisodePattern("Show.Ep05.720p.mkv", 1, 5));
  });

  it("is case insensitive", () => {
    assert.ok(matchEpisodePattern("Show.s01e05.720p.mkv", 1, 5));
    assert.ok(matchEpisodePattern("Show.S01e05.720p.mkv", 1, 5));
  });

  it("does not match wrong episode", () => {
    assert.ok(!matchEpisodePattern("Show.S01E06.720p.mkv", 1, 5));
    assert.ok(!matchEpisodePattern("Show.S02E05.720p.mkv", 2, 6));
  });

  it("does not match episode number as part of larger number", () => {
    // S01E50 should not match episode 5
    assert.ok(!matchEpisodePattern("Show.S01E50.720p.mkv", 1, 5));
  });

  it("uses filename not full path", () => {
    assert.ok(matchEpisodePattern("Season 1/Show.S01E05.720p.mkv", 1, 5));
  });

  it("handles double-digit episodes", () => {
    assert.ok(matchEpisodePattern("Show.S01E12.720p.mkv", 1, 12));
    assert.ok(matchEpisodePattern("Show.S02E25.720p.mkv", 2, 25));
  });
});

describe("findLargestVideoFile", () => {
  it("returns null for null/undefined files", () => {
    assert.equal(findLargestVideoFile(null), null);
    assert.equal(findLargestVideoFile(undefined), null);
  });

  it("returns null for empty array", () => {
    assert.equal(findLargestVideoFile([]), null);
  });

  it("picks the largest video file", () => {
    const files = [
      { name: "small.mp4", length: 100 },
      { name: "big.mp4", length: 5000 },
      { name: "medium.mkv", length: 3000 },
    ];
    const result = findLargestVideoFile(files);
    assert.equal(result.index, 1);
    assert.equal(result.file.name, "big.mp4");
  });

  it("skips non-video files", () => {
    const files = [
      { name: "readme.txt", length: 999999 },
      { name: "movie.mp4", length: 1000 },
    ];
    const result = findLargestVideoFile(files);
    assert.equal(result.file.name, "movie.mp4");
  });

  it("returns null when no video files exist", () => {
    const files = [
      { name: "subs.srt", length: 5000 },
      { name: "readme.nfo", length: 1000 },
    ];
    assert.equal(findLargestVideoFile(files), null);
  });
});

describe("findEpisodeFile", () => {
  it("finds episode by S01E05 pattern", () => {
    const files = [
      { name: "Show.S01E04.720p.mkv", length: 500 },
      { name: "Show.S01E05.720p.mkv", length: 500 },
      { name: "Show.S01E06.720p.mkv", length: 500 },
    ];
    const result = findEpisodeFile(files, 1, 5);
    assert.equal(result.file.name, "Show.S01E05.720p.mkv");
    assert.equal(result.index, 1);
  });

  it("falls back to largest video when no episode match", () => {
    const files = [
      { name: "small.mp4", length: 100 },
      { name: "big.mp4", length: 5000 },
    ];
    const result = findEpisodeFile(files, 1, 5);
    assert.equal(result.file.name, "big.mp4");
  });

  it("falls back to largest video when no season/episode given", () => {
    const files = [
      { name: "Show.S01E05.720p.mkv", length: 100 },
      { name: "big.mp4", length: 5000 },
    ];
    const result = findEpisodeFile(files, null, null);
    assert.equal(result.file.name, "big.mp4");
  });

  it("returns null for null files", () => {
    assert.equal(findEpisodeFile(null, 1, 5), null);
  });
});
