import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestServer } from "../helpers/mock-app.js";

describe("learn-offset routes", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let tmp: string;
  let savedEnv: string | undefined;

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "learn-offset-"));
    savedEnv = process.env.MAGNET_CONFIG_DIR;
    process.env.MAGNET_CONFIG_DIR = tmp;
    ({ baseUrl, close } = await startTestServer());
  });

  after(async () => {
    await close();
    if (savedEnv === undefined) delete process.env.MAGNET_CONFIG_DIR;
    else process.env.MAGNET_CONFIG_DIR = savedEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("POST /api/learn-offset", () => {
    it("accepts a valid outro sample", async () => {
      const res = await fetch(`${baseUrl}/api/learn-offset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: "123", type: "outro", offset_sec: 1278, season: 1, episode: 3 }),
      });
      assert.equal(res.status, 200);
    });
    it("rejects missing tmdbId", async () => {
      const res = await fetch(`${baseUrl}/api/learn-offset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "outro", offset_sec: 1278, season: 1, episode: 3 }),
      });
      assert.equal(res.status, 400);
    });
  });

  describe("GET /api/learn-offset/:tmdbId", () => {
    it("returns null offset when insufficient samples", async () => {
      const res = await fetch(`${baseUrl}/api/learn-offset/999`);
      assert.equal(res.status, 200);
      const body = await res.json() as { outro_offset: number | null; sample_count: number };
      assert.equal(body.outro_offset, null);
    });
    it("returns median after two close samples", async () => {
      await fetch(`${baseUrl}/api/learn-offset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: "42", type: "outro", offset_sec: 1278, season: 1, episode: 1 }),
      });
      await fetch(`${baseUrl}/api/learn-offset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: "42", type: "outro", offset_sec: 1279, season: 1, episode: 2 }),
      });
      const res = await fetch(`${baseUrl}/api/learn-offset/42`);
      const body = await res.json() as { outro_offset: number | null; sample_count: number };
      assert.equal(body.outro_offset, 1278.5);
      assert.equal(body.sample_count, 2);
    });
  });
});
