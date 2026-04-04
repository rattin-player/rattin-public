import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseTorrentioTitle, parseSizeStr, searchTorrentio, parseTorrentioMeta } from "../lib/torrent/torrentio.js";

// ---------------------------------------------------------------------------
// parseTorrentioTitle tests
// ---------------------------------------------------------------------------

describe("parseTorrentioTitle", () => {
  it("parses a standard 3-line title", () => {
    const title = [
      "The.Simpsons.S15.1080p.BluRay.x265-KONTRAST",
      "Season 15/The.Simpsons.S15E01.mkv",
      "👤 43 💾 421.34 MB ⚙️ TorrentGalaxy",
    ].join("\n");
    const result = parseTorrentioTitle(title);
    assert.equal(result.torrentName, "The.Simpsons.S15.1080p.BluRay.x265-KONTRAST");
    assert.equal(result.seeders, 43);
    assert.equal(result.sizeStr, "421.34 MB");
    assert.equal(result.source, "TorrentGalaxy");
  });

  it("parses title with language flags on line 4", () => {
    const title = [
      "The.Simpsons.S15.1080p.BluRay.x265-KONTRAST",
      "Season 15/The.Simpsons.S15E01.mkv",
      "👤 43 💾 421.34 MB ⚙️ TorrentGalaxy",
      "🇺🇸 🇬🇧",
    ].join("\n");
    const result = parseTorrentioTitle(title);
    assert.equal(result.seeders, 43);
    assert.equal(result.sizeStr, "421.34 MB");
    assert.equal(result.source, "TorrentGalaxy");
  });

  it("parses GB sizes correctly", () => {
    const title = [
      "Inception.2010.2160p.BluRay.x265-GROUP",
      "Inception.2010.2160p.BluRay.x265-GROUP.mkv",
      "👤 120 💾 8.91 GB ⚙️ RARBG",
    ].join("\n");
    const result = parseTorrentioTitle(title);
    assert.equal(result.sizeStr, "8.91 GB");
    // 8.91 GB = 8.91 * 1024^3 bytes
    const expected = Math.round(8.91 * 1024 ** 3);
    assert.equal(result.sizeBytes, expected);
  });

  it("returns 0 seeders when seeders are missing", () => {
    const title = [
      "Some.Movie.2023.1080p",
      "Some.Movie.2023.1080p.mkv",
      "💾 700 MB ⚙️ SomeSource",
    ].join("\n");
    const result = parseTorrentioTitle(title);
    assert.equal(result.seeders, 0);
  });

  it("returns empty string for sizeStr when size is missing", () => {
    const title = [
      "Some.Movie.2023.1080p",
      "Some.Movie.2023.1080p.mkv",
      "👤 10 ⚙️ SomeSource",
    ].join("\n");
    const result = parseTorrentioTitle(title);
    assert.equal(result.sizeStr, "");
    assert.equal(result.sizeBytes, 0);
  });

  it("handles a single-line title (edge case)", () => {
    const title = "Just.A.Torrent.Name.1080p";
    const result = parseTorrentioTitle(title);
    assert.equal(result.torrentName, "Just.A.Torrent.Name.1080p");
    assert.equal(result.seeders, 0);
  });
});

// ---------------------------------------------------------------------------
// parseTorrentioMeta tests
// ---------------------------------------------------------------------------

describe("parseTorrentioMeta", () => {
  it("extracts flag emojis from line 4", () => {
    const title = "Torrent.Name\nfile.mkv\n👤 10 💾 500 MB ⚙️ TPB\nMulti Subs / 🇬🇧 / 🇮🇹";
    const meta = parseTorrentioMeta(title);
    assert.deepEqual(meta.languages, ["🇬🇧", "🇮🇹"]);
  });

  it("detects Multi Subs", () => {
    const title = "Torrent.Name\nfile.mkv\n👤 10 💾 500 MB ⚙️ TPB\nMulti Subs / 🇬🇧";
    const meta = parseTorrentioMeta(title);
    assert.equal(meta.hasSubs, true);
  });

  it("detects MultiSub in torrent name", () => {
    const title = "Movie.2024.1080p.MultiSub.BluRay\nfile.mkv\n👤 10 💾 500 MB ⚙️ TPB";
    const meta = parseTorrentioMeta(title);
    assert.equal(meta.hasSubs, true);
  });

  it("detects SUB language codes in torrent name", () => {
    const title = "Movie [SUB ITA ENG]\nfile.mkv\n👤 10 💾 500 MB ⚙️ TPB";
    const meta = parseTorrentioMeta(title);
    assert.equal(meta.hasSubs, true);
  });

  it("detects Multi Audio from line 4", () => {
    const title = "Torrent.Name\nfile.mkv\n👤 10 💾 500 MB ⚙️ TPB\nMulti Audio / Multi Subs";
    const meta = parseTorrentioMeta(title);
    assert.equal(meta.multiAudio, true);
    assert.equal(meta.hasSubs, true);
  });

  it("detects Dual Audio from line 4", () => {
    const title = "Torrent.Name\nfile.mkv\n👤 10 💾 500 MB ⚙️ TPB\nDual Audio / 🇵🇹";
    const meta = parseTorrentioMeta(title);
    assert.equal(meta.multiAudio, true);
    assert.deepEqual(meta.languages, ["🇵🇹"]);
  });

  it("detects DUAL in torrent name", () => {
    const title = "Movie.2024.DUAL.1080p.WEB-DL\nfile.mkv\n👤 10 💾 500 MB ⚙️ TPB";
    const meta = parseTorrentioMeta(title);
    assert.equal(meta.multiAudio, true);
  });

  it("returns defaults when no metadata present", () => {
    const title = "Movie.2024.1080p.BluRay\nfile.mkv\n👤 10 💾 500 MB ⚙️ TPB";
    const meta = parseTorrentioMeta(title);
    assert.deepEqual(meta.languages, []);
    assert.equal(meta.hasSubs, false);
    assert.equal(meta.multiAudio, false);
  });

  it("handles single-line title", () => {
    const title = "Movie.2024.1080p";
    const meta = parseTorrentioMeta(title);
    assert.deepEqual(meta.languages, []);
    assert.equal(meta.hasSubs, false);
    assert.equal(meta.multiAudio, false);
  });

  it("detects foreign-only (flags but no English)", () => {
    const title = "Movie\nfile.mkv\n👤 10 💾 500 MB ⚙️ TPB\n🇷🇺";
    const meta = parseTorrentioMeta(title);
    assert.deepEqual(meta.languages, ["🇷🇺"]);
    assert.equal(meta.foreignOnly, true);
  });

  it("not foreign-only when English flag present", () => {
    const title = "Movie\nfile.mkv\n👤 10 💾 500 MB ⚙️ TPB\n🇬🇧 / 🇮🇹";
    const meta = parseTorrentioMeta(title);
    assert.equal(meta.foreignOnly, false);
  });

  it("not foreign-only when no flags at all", () => {
    const title = "Movie\nfile.mkv\n👤 10 💾 500 MB ⚙️ TPB";
    const meta = parseTorrentioMeta(title);
    assert.equal(meta.foreignOnly, false);
  });

  // Text language code parsing
  it("extracts language flags from text codes like iTA.ENG", () => {
    const title = "I.Simpson.S15E01.WEBMux.720p.x264.iTA.ENG.AC3\nfile.mkv\n👤 5 💾 355 MB ⚙️ 1337x";
    const meta = parseTorrentioMeta(title);
    assert.ok(meta.languages.includes("🇮🇹"));
    assert.ok(meta.languages.includes("🇬🇧"));
  });

  it("extracts language flags from bracketed codes [ENG+ITA]", () => {
    const title = "Movie [SUB ITA ENG]\nfile.mkv\n👤 10 💾 500 MB ⚙️ TPB";
    const meta = parseTorrentioMeta(title);
    assert.ok(meta.languages.includes("🇮🇹"));
    assert.ok(meta.languages.includes("🇬🇧"));
  });

  it("does not duplicate flags from both emoji and text codes", () => {
    const title = "Movie.ENG\nfile.mkv\n👤 10 💾 500 MB ⚙️ TPB\n🇬🇧";
    const meta = parseTorrentioMeta(title);
    const gbCount = meta.languages.filter((f) => f === "🇬🇧").length;
    assert.equal(gbCount, 1);
  });

  it("detects multi 8 lang pattern", () => {
    const title = "Movie (Multi 8 lang)(MultiSub)\nfile.mkv\n👤 1 💾 500 MB ⚙️ TPB";
    const meta = parseTorrentioMeta(title);
    assert.equal(meta.multiAudio, true);
    assert.equal(meta.hasSubs, true);
  });

  it("not foreign-only when ENG text code found", () => {
    const title = "Movie.iTA.ENG.AC3\nfile.mkv\n👤 5 💾 355 MB ⚙️ 1337x";
    const meta = parseTorrentioMeta(title);
    assert.equal(meta.foreignOnly, false);
  });
});

// ---------------------------------------------------------------------------
// parseSizeStr tests
// ---------------------------------------------------------------------------

describe("parseSizeStr", () => {
  it("parses MB values", () => {
    assert.equal(parseSizeStr("421.34 MB"), Math.round(421.34 * 1024 ** 2));
  });

  it("parses GB values", () => {
    assert.equal(parseSizeStr("8.91 GB"), Math.round(8.91 * 1024 ** 3));
  });

  it("parses TB values", () => {
    assert.equal(parseSizeStr("1.5 TB"), Math.round(1.5 * 1024 ** 4));
  });

  it("returns 0 for empty string", () => {
    assert.equal(parseSizeStr(""), 0);
  });

  it("parses GiB values (same as GB)", () => {
    assert.equal(parseSizeStr("8.91 GiB"), Math.round(8.91 * 1024 ** 3));
  });
});

// ---------------------------------------------------------------------------
// searchTorrentio tests — mock globalThis.fetch
// ---------------------------------------------------------------------------

const SERIES_STREAMS = {
  streams: [
    {
      name: "Torrentio\n4K",
      title: "The.Simpsons.S15.1080p.BluRay.x265-KONTRAST\nSeason 15/The.Simpsons.S15E01.mkv\n👤 43 💾 421.34 MB ⚙️ TorrentGalaxy",
      infoHash: "AABBCCDD1122334455667788990011AABBCCDD11",
      fileIdx: 1,
    },
    {
      name: "Torrentio\n1080p",
      title: "The.Simpsons.S15E01.1080p.WEB-DL-GROUP\nThe.Simpsons.S15E01.1080p.WEB-DL-GROUP.mkv\n👤 12 💾 850 MB ⚙️ YTS",
      infoHash: "BBCCDD1122334455667788990011AABBCCDD1122",
      fileIdx: 0,
    },
    {
      // no infoHash — should be filtered out
      name: "Torrentio",
      title: "Bad.Stream\nBad.Stream.mkv\n👤 5 💾 100 MB ⚙️ Unknown",
      infoHash: "",
    },
  ],
};

describe("searchTorrentio", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("maps series streams to TorrentioResult array", async () => {
    globalThis.fetch = async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify(SERIES_STREAMS), { status: 200 });
    };

    const results = await searchTorrentio("tt0096697", "tv", 15, 1);
    // filtered: 2 results (one had empty infoHash)
    assert.equal(results.length, 2);

    const first = results[0];
    assert.equal(first.infoHash, "aabbccdd1122334455667788990011aabbccdd11");
    assert.equal(first.seeders, 43);
    assert.equal(first.fileIdx, 1);
    assert.equal(first.source, "TorrentGalaxy");
    // fileIdx !== undefined and torrentName has no SxxExx pattern → seasonPack = true
    assert.equal(first.seasonPack, true);

    const second = results[1];
    assert.equal(second.infoHash, "bbccdd1122334455667788990011aabbccdd1122");
    assert.equal(second.seeders, 12);
    assert.equal(second.fileIdx, 0);
    assert.equal(second.seasonPack, false);
  });

  it("returns empty array on non-200 response", async () => {
    globalThis.fetch = async () => new Response("Not Found", { status: 404 });
    const results = await searchTorrentio("tt0096697", "tv", 15, 1);
    assert.deepEqual(results, []);
  });

  it("returns empty array on network error", async () => {
    globalThis.fetch = async () => {
      throw new Error("Network error");
    };
    const results = await searchTorrentio("tt0096697", "tv", 15, 1);
    assert.deepEqual(results, []);
  });

  it("returns empty array when streams is empty", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ streams: [] }), { status: 200 });
    const results = await searchTorrentio("tt0096697", "tv", 15, 1);
    assert.deepEqual(results, []);
  });

  it("builds correct URL for movies", async () => {
    let capturedUrl = "";
    globalThis.fetch = async (url: RequestInfo | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ streams: [] }), { status: 200 });
    };
    await searchTorrentio("tt1375666", "movie");
    assert.equal(capturedUrl, "https://torrentio.strem.fun/stream/movie/tt1375666.json");
  });

  it("builds correct URL for series", async () => {
    let capturedUrl = "";
    globalThis.fetch = async (url: RequestInfo | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ streams: [] }), { status: 200 });
    };
    await searchTorrentio("tt0096697", "tv", 15, 1);
    assert.equal(capturedUrl, "https://torrentio.strem.fun/stream/series/tt0096697:15:1.json");
  });
});
