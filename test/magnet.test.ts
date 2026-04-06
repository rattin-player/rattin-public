import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMagnet } from "../src/lib/magnet.js";

describe("parseMagnet", () => {
  it("returns null for a plain search query", () => {
    assert.equal(parseMagnet("breaking bad"), null);
  });

  it("returns null for an empty string", () => {
    assert.equal(parseMagnet(""), null);
  });

  it("returns null for a magnet missing xt param", () => {
    assert.equal(parseMagnet("magnet:?dn=Something"), null);
  });

  it("parses a minimal magnet with only infoHash", () => {
    const result = parseMagnet("magnet:?xt=urn:btih:abc123def456abc123def456abc123def456abc1");
    assert.deepEqual(result, {
      infoHash: "abc123def456abc123def456abc123def456abc1",
      name: "abc123def456abc123def456abc123def456abc1",
    });
  });

  it("parses a magnet with dn and lowercases the hash", () => {
    const result = parseMagnet(
      "magnet:?xt=urn:btih:ABC123DEF456ABC123DEF456ABC123DEF456ABC1&dn=Breaking%20Bad%20S01"
    );
    assert.deepEqual(result, {
      infoHash: "abc123def456abc123def456abc123def456abc1",
      name: "Breaking Bad S01",
    });
  });

  it("parses a full magnet with trackers and extra params", () => {
    const result = parseMagnet(
      "magnet:?xt=urn:btih:aabbccddeeff0011223344556677889900aabbcc&dn=Some+Movie+2024&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&xl=1234567890"
    );
    assert.deepEqual(result, {
      infoHash: "aabbccddeeff0011223344556677889900aabbcc",
      name: "Some Movie 2024",
    });
  });
});
