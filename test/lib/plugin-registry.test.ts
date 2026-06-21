// test/lib/plugin-registry.test.ts
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { PluginRegistryImpl } from "../../lib/plugins/registry.js";
import type { PluginIndexEntry } from "../../lib/plugins/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "..", "fixtures");
const mockPluginPath = path.join(fixtureDir, "mock-plugin.js");
const devKeyJson = JSON.parse(
  readFileSync(path.join(fixtureDir, "dev-private-key.json"), "utf8")
) as { base64: string; format: "der"; type: "pkcs8" };

// Create a temp directory for plugin storage so tests don't touch ~/.config
const tempPluginDir = path.join(process.env.TMPDIR || "/tmp", "rattin-test-plugins-" + Date.now());

function signWithDevKey(data: Buffer): Buffer {
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(devKeyJson.base64, "base64"),
    format: devKeyJson.format,
    type: devKeyJson.type,
  });
  return crypto.sign(null, data, privKey);
}

function makeRegistry(): PluginRegistryImpl {
  return new PluginRegistryImpl({
    log: () => {},
    pluginDir: tempPluginDir,
    allowUnsigned: false,
  });
}

function makeSignedMockPlugin(): { pluginPath: string; signature: Buffer } {
  const content = readFileSync(mockPluginPath);
  const signature = signWithDevKey(content);
  const signedPath = path.join(tempPluginDir, "rattin-sources.js");
  mkdirSync(tempPluginDir, { recursive: true });
  writeFileSync(signedPath, content);
  return { pluginPath: signedPath, signature };
}

const mockIndexEntry: PluginIndexEntry = {
  id: "rattin-sources",
  name: "Content Sources",
  description: "Community content sources — search and play",
  author: "rattin",
  downloadUrl: "https://cdn.rattin.app/plugins/rattin-sources/v1.0.0.js",
  sha256: "",
  version: "1.0.0",
  apiVersion: 1,
};

describe("PluginRegistryImpl", () => {
  before(() => {
    mkdirSync(tempPluginDir, { recursive: true });
  });

  after(() => {
    try { rmSync(tempPluginDir, { recursive: true, force: true }); } catch {}
  });

  describe("getStatus", () => {
    it("returns not-installed status when no plugin is present", () => {
      const reg = makeRegistry();
      const status = reg.getStatus();
      assert.equal(status.installed, false);
      assert.equal(status.plugin, null);
      assert.equal(status.running, false);
    });
  });

  describe("installFromFile (dev mode)", () => {
    it("spawns the plugin and isRunning returns true", async () => {
      const reg = new PluginRegistryImpl({
        log: () => {},
        pluginDir: tempPluginDir,
        allowUnsigned: true,
      });
      try {
        await reg.installFromFile(mockPluginPath);
        assert.equal(reg.isInstalled(), true);
        assert.equal(reg.isRunning(), true);
        const status = reg.getStatus();
        assert.ok(status.plugin, "plugin meta should be set");
        assert.equal(status.plugin!.name, "Mock Plugin");
      } finally {
        reg.stop();
      }
    });
  });

  describe("installFromUrl (signed)", () => {
    it("rejects an unsigned plugin when allowUnsigned is false", async () => {
      const reg = makeRegistry();
      // Simulate a download that returns unsigned content
      const content = readFileSync(mockPluginPath);
      const tmpUrl = "file://" + mockPluginPath;
      try {
        await assert.rejects(
          reg.installFromUrl(tmpUrl, { ...mockIndexEntry, sha256: crypto.createHash("sha256").update(content).digest("hex") }),
          /signature/i
        );
      } finally {
        reg.stop();
      }
    });
  });

  describe("search via plugin process", () => {
    let reg: PluginRegistryImpl;

    before(async () => {
      reg = new PluginRegistryImpl({
        log: () => {},
        pluginDir: tempPluginDir,
        allowUnsigned: true,
      });
      await reg.installFromFile(mockPluginPath);
    });

    after(() => {
      reg.stop();
    });

    it("returns search results from the plugin", async () => {
      const results = await reg.search({ query: "Test Movie", type: "movie" });
      assert.ok(Array.isArray(results));
      assert.ok(results.length > 0);
      assert.ok(results[0].infoHash, "result should have infoHash");
    });

    it("returns batch search results", async () => {
      const results = await reg.searchBatch([
        { query: "Show S01E01", type: "tv", season: 1, episode: 1 },
        { query: "Show S01", type: "tv", season: 1 },
      ]);
      assert.equal(results.length, 2);
      assert.ok(results[0].length > 0);
      assert.ok(results[1].length > 0);
    });

    it("returns availability results", async () => {
      const result = await reg.availability([
        { title: "Movie A", type: "movie" },
        { title: "Movie B", type: "movie" },
      ]);
      assert.ok(result.available.includes(0));
      assert.ok(result.available.includes(1));
    });
  });

  describe("uninstall", () => {
    it("kills the process and clears status", async () => {
      const reg = new PluginRegistryImpl({
        log: () => {},
        pluginDir: tempPluginDir,
        allowUnsigned: true,
      });
      await reg.installFromFile(mockPluginPath);
      assert.equal(reg.isRunning(), true);
      await reg.uninstall();
      assert.equal(reg.isInstalled(), false);
      assert.equal(reg.isRunning(), false);
    });
  });

  describe("restart on crash", () => {
    it("restarts the plugin process after it exits unexpectedly", async () => {
      const reg = new PluginRegistryImpl({
        log: () => {},
        pluginDir: tempPluginDir,
        allowUnsigned: true,
        restartDelayOverride: 100, // speed up the backoff for testing
      });
      try {
        await reg.installFromFile(mockPluginPath);
        assert.equal(reg.isRunning(), true);

        // Kill the process unexpectedly (simulating a crash)
        reg.killProcessForTest();

        // Wait for the restart to kick in (backoff + spawn + health)
        // The registry should detect the exit and schedule a restart
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // The plugin should be running again
        assert.equal(reg.isRunning(), true, "plugin should have restarted after crash");

        // Verify it actually works
        const results = await reg.search({ query: "Test", type: "movie" });
        assert.ok(results.length > 0);
      } finally {
        reg.stop();
      }
    });
  });
});
