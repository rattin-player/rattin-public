import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LearnedOffsetsStore } from "../../lib/storage/learned-offsets.js";

let tmp: string;
let storePath: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "learned-"));
  storePath = path.join(tmp, "learned-offsets.json");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("LearnedOffsetsStore", () => {
  it("returns null when no samples", () => {
    const s = new LearnedOffsetsStore(storePath);
    assert.equal(s.getOutroOffset("123"), null);
  });
  it("requires 2+ samples within 3s to return offset", () => {
    const s = new LearnedOffsetsStore(storePath);
    s.addOutroSample("123", { offset: 1278, at: "2026-01-01T00:00:00Z", season: 1, episode: 1 });
    assert.equal(s.getOutroOffset("123"), null);
    s.addOutroSample("123", { offset: 1279, at: "2026-01-01T01:00:00Z", season: 1, episode: 2 });
    const r = s.getOutroOffset("123");
    assert.ok(r !== null);
    assert.equal(r!.offset, 1278.5);
    assert.equal(r!.sampleCount, 2);
  });
  it("rejects samples with spread > 3s", () => {
    const s = new LearnedOffsetsStore(storePath);
    s.addOutroSample("123", { offset: 1200, at: "a", season: 1, episode: 1 });
    s.addOutroSample("123", { offset: 1300, at: "b", season: 1, episode: 2 });
    assert.equal(s.getOutroOffset("123"), null);
  });
  it("persists to disk and reloads", () => {
    const s1 = new LearnedOffsetsStore(storePath);
    s1.addOutroSample("123", { offset: 1278, at: "a", season: 1, episode: 1 });
    s1.addOutroSample("123", { offset: 1279, at: "b", season: 1, episode: 2 });
    const s2 = new LearnedOffsetsStore(storePath);
    assert.ok(s2.getOutroOffset("123") !== null);
  });
});
