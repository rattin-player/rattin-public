import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { startTestServer } from "../helpers/mock-app.js";

const TEST_CACHE_DIR = path.join(os.tmpdir(), "rattin-test-cache-" + process.pid);

describe("Cache routes", () => {
  let baseUrl: string, close: () => Promise<void>;

  before(async () => {
    process.env.DOWNLOAD_PATH = TEST_CACHE_DIR;
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
    ({ baseUrl, close } = await startTestServer());
  });

  after(async () => {
    await close();
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    delete process.env.DOWNLOAD_PATH;
  });

  beforeEach(() => {
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
  });

  describe("GET /api/cache/size", () => {
    it("returns 0 for empty directory", async () => {
      const res = await fetch(`${baseUrl}/api/cache/size`);
      assert.equal(res.status, 200);
      const body = await res.json() as { bytes: number; formatted: string };
      assert.equal(body.bytes, 0);
      assert.equal(body.formatted, "0 B");
    });

    it("returns non-zero size for files", async () => {
      writeFileSync(path.join(TEST_CACHE_DIR, "test.bin"), Buffer.alloc(1024));
      const res = await fetch(`${baseUrl}/api/cache/size`);
      const body = await res.json() as { bytes: number; formatted: string };
      assert.ok(body.bytes > 0, "bytes should be > 0");
      assert.ok(body.formatted !== "0 B", "formatted should not be 0 B");
    });
  });

  describe("DELETE /api/cache", () => {
    it("clears all files", async () => {
      writeFileSync(path.join(TEST_CACHE_DIR, "a.bin"), Buffer.alloc(512));
      writeFileSync(path.join(TEST_CACHE_DIR, "b.bin"), Buffer.alloc(512));

      const res = await fetch(`${baseUrl}/api/cache`, { method: "DELETE" });
      assert.equal(res.status, 200);
      const body = await res.json() as { cleared: boolean };
      assert.equal(body.cleared, true);

      const sizeRes = await fetch(`${baseUrl}/api/cache/size`);
      const sizeBody = await sizeRes.json() as { bytes: number };
      assert.equal(sizeBody.bytes, 0);
    });

    it("succeeds on empty directory", async () => {
      const res = await fetch(`${baseUrl}/api/cache`, { method: "DELETE" });
      assert.equal(res.status, 200);
    });
  });
});
