import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  needsTranscode, isAllowedFile, srtToVtt, magnetToInfoHash, fmtBytes, throttle,
  VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, SUBTITLE_EXTENSIONS, ALLOWED_EXTENSIONS, BROWSER_NATIVE,
} from "../lib/media-utils.js";

describe("needsTranscode", () => {
  it("returns false for browser-native formats", () => {
    assert.equal(needsTranscode(".mp4"), false);
    assert.equal(needsTranscode(".m4v"), false);
    assert.equal(needsTranscode(".webm"), false);
  });

  it("returns true for non-native formats", () => {
    assert.equal(needsTranscode(".mkv"), true);
    assert.equal(needsTranscode(".avi"), true);
    assert.equal(needsTranscode(".mov"), true);
    assert.equal(needsTranscode(".ts"), true);
    assert.equal(needsTranscode(".flv"), true);
    assert.equal(needsTranscode(".wmv"), true);
  });
});

describe("isAllowedFile", () => {
  it("allows video files", () => {
    assert.equal(isAllowedFile("movie.mp4"), true);
    assert.equal(isAllowedFile("movie.mkv"), true);
    assert.equal(isAllowedFile("movie.avi"), true);
  });

  it("allows audio files", () => {
    assert.equal(isAllowedFile("song.mp3"), true);
    assert.equal(isAllowedFile("track.flac"), true);
  });

  it("allows subtitle files", () => {
    assert.equal(isAllowedFile("subs.srt"), true);
    assert.equal(isAllowedFile("subs.vtt"), true);
    assert.equal(isAllowedFile("subs.ass"), true);
  });

  it("rejects non-media files", () => {
    assert.equal(isAllowedFile("virus.exe"), false);
    assert.equal(isAllowedFile("archive.zip"), false);
    assert.equal(isAllowedFile("readme.txt"), false);
    assert.equal(isAllowedFile("image.jpg"), false);
    assert.equal(isAllowedFile("script.js"), false);
  });

  it("handles case insensitive extensions", () => {
    assert.equal(isAllowedFile("MOVIE.MP4"), true);
    assert.equal(isAllowedFile("movie.MKV"), true);
  });

  it("handles paths with directories", () => {
    assert.equal(isAllowedFile("Movies/2024/movie.mp4"), true);
    assert.equal(isAllowedFile("data/readme.txt"), false);
  });
});

describe("srtToVtt", () => {
  it("converts basic SRT to VTT", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,000 --> 00:00:08,000
Second line`;

    const vtt = srtToVtt(srt);
    assert.ok(vtt.startsWith("WEBVTT\n\n"));
    assert.ok(vtt.includes("00:00:01.000 --> 00:00:04.000"));
    assert.ok(vtt.includes("Hello world"));
    assert.ok(vtt.includes("00:00:05.000 --> 00:00:08.000"));
    assert.ok(vtt.includes("Second line"));
  });

  it("converts commas to dots in timestamps", () => {
    const srt = `1
00:01:23,456 --> 00:01:26,789
Test`;
    const vtt = srtToVtt(srt);
    assert.ok(vtt.includes("00:01:23.456 --> 00:01:26.789"));
    assert.ok(!vtt.includes(","));
  });

  it("handles \\r\\n line endings", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld";
    const vtt = srtToVtt(srt);
    assert.ok(vtt.includes("Hello"));
    assert.ok(vtt.includes("World"));
  });

  it("skips blocks without timestamps", () => {
    const srt = `This is not a subtitle block

1
00:00:01,000 --> 00:00:02,000
Real subtitle`;
    const vtt = srtToVtt(srt);
    assert.ok(vtt.includes("Real subtitle"));
    assert.ok(!vtt.includes("This is not"));
  });

  it("skips blocks with empty text", () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000


2
00:00:03,000 --> 00:00:04,000
Actual text`;
    const vtt = srtToVtt(srt);
    assert.ok(vtt.includes("Actual text"));
    // The empty block should be skipped
    const blocks = vtt.split("\n\n").filter((b: string) => b.trim() && b.trim() !== "WEBVTT");
    assert.equal(blocks.length, 1);
  });
});

describe("magnetToInfoHash", () => {
  it("extracts info hash from valid magnet link", () => {
    const magnet = "magnet:?xt=urn:btih:abcdef1234567890abcdef1234567890abcdef12&dn=Test";
    assert.equal(magnetToInfoHash(magnet), "abcdef1234567890abcdef1234567890abcdef12");
  });

  it("lowercases the hash", () => {
    const magnet = "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12&dn=Test";
    assert.equal(magnetToInfoHash(magnet), "abcdef1234567890abcdef1234567890abcdef12");
  });

  it("returns null for invalid magnet", () => {
    assert.equal(magnetToInfoHash("not a magnet"), null);
    assert.equal(magnetToInfoHash("magnet:?xt=urn:btih:tooshort"), null);
    assert.equal(magnetToInfoHash(""), null);
  });
});

describe("fmtBytes", () => {
  it("formats zero", () => {
    assert.equal(fmtBytes(0), "0 B");
  });

  it("formats bytes", () => {
    assert.equal(fmtBytes(500), "500.0 B");
  });

  it("formats kilobytes", () => {
    assert.equal(fmtBytes(1024), "1.0 KB");
    assert.equal(fmtBytes(1536), "1.5 KB");
  });

  it("formats megabytes", () => {
    assert.equal(fmtBytes(1048576), "1.0 MB");
  });

  it("formats gigabytes", () => {
    assert.equal(fmtBytes(1073741824), "1.0 GB");
  });

  it("formats terabytes", () => {
    assert.equal(fmtBytes(1099511627776), "1.0 TB");
  });
});

describe("throttle", () => {
  it("calls function immediately on first invocation", () => {
    let count = 0;
    const fn = throttle(() => count++, 1000);
    fn();
    assert.equal(count, 1);
  });

  it("suppresses rapid subsequent calls", () => {
    let count = 0;
    const fn = throttle(() => count++, 1000);
    fn();
    fn();
    fn();
    assert.equal(count, 1);
  });

  it("passes arguments through", () => {
    let received: unknown[];
    const fn = throttle((...args: unknown[]) => { received = args; }, 1000);
    fn("a", "b");
    assert.deepEqual(received!, ["a", "b"]);
  });
});

describe("constants", () => {
  it("VIDEO_EXTENSIONS includes common formats", () => {
    assert.ok(VIDEO_EXTENSIONS.includes(".mp4"));
    assert.ok(VIDEO_EXTENSIONS.includes(".mkv"));
    assert.ok(VIDEO_EXTENSIONS.includes(".avi"));
  });

  it("BROWSER_NATIVE is a subset of video extensions", () => {
    for (const ext of BROWSER_NATIVE) {
      assert.ok(VIDEO_EXTENSIONS.includes(ext), `${ext} should be in VIDEO_EXTENSIONS`);
    }
  });

  it("ALLOWED_EXTENSIONS includes all media types", () => {
    for (const ext of VIDEO_EXTENSIONS) assert.ok(ALLOWED_EXTENSIONS.has(ext));
    for (const ext of AUDIO_EXTENSIONS) assert.ok(ALLOWED_EXTENSIONS.has(ext));
    for (const ext of SUBTITLE_EXTENSIONS) assert.ok(ALLOWED_EXTENSIONS.has(ext));
  });
});
