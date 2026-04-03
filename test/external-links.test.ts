import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isExternalUrl } from "../src/lib/external-links.js";

describe("isExternalUrl", () => {
  it("returns true for https URLs", () => {
    assert.equal(isExternalUrl("https://www.youtube.com/watch?v=abc"), true);
    assert.equal(isExternalUrl("https://www.imdb.com/title/tt123/reviews"), true);
    assert.equal(isExternalUrl("https://reddit.com/r/movies/comments/abc"), true);
  });

  it("returns true for http URLs", () => {
    assert.equal(isExternalUrl("http://example.com"), true);
  });

  it("returns false for relative paths", () => {
    assert.equal(isExternalUrl("/movie/123"), false);
    assert.equal(isExternalUrl("/play/abc/0"), false);
    assert.equal(isExternalUrl("/search?q=test"), false);
  });

  it("returns false for empty or missing URLs", () => {
    assert.equal(isExternalUrl(""), false);
    assert.equal(isExternalUrl(null as unknown as string), false);
    assert.equal(isExternalUrl(undefined as unknown as string), false);
  });

  it("returns false for hash-only URLs", () => {
    assert.equal(isExternalUrl("#section"), false);
  });

  it("returns false for javascript: URLs", () => {
    assert.equal(isExternalUrl("javascript:void(0)"), false);
  });
});
