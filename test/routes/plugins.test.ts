// test/routes/plugins.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../helpers/mock-app.js";
import { MockPluginRegistry } from "../helpers/mock-plugin.js";
import type { PluginRegistry } from "../../lib/plugins/types.js";

describe("Plugin routes", () => {
  let baseUrl: string, close: () => Promise<void>;

  describe("without a plugin installed", () => {
    before(async () => {
      ({ baseUrl, close } = await startTestServer({}));
    });
    after(async () => { await close(); });

    it("GET /api/plugins/status returns installed=false", async () => {
      const res = await fetch(`${baseUrl}/api/plugins/status`);
      assert.equal(res.status, 200);
      const body = await res.json() as { installed: boolean; running: boolean };
      assert.equal(body.installed, false);
      assert.equal(body.running, false);
    });

    it("GET /api/plugins/index returns the local fallback index", async () => {
      const res = await fetch(`${baseUrl}/api/plugins/index`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body));
    });
  });

  describe("with a mock plugin installed", () => {
    let registry: MockPluginRegistry;
    before(async () => {
      registry = new MockPluginRegistry({ installed: true, running: true });
      ({ baseUrl, close } = await startTestServer({ pluginRegistry: registry as unknown as PluginRegistry }));
    });
    after(async () => { await close(); });

    it("GET /api/plugins/status returns installed=true, running=true", async () => {
      const res = await fetch(`${baseUrl}/api/plugins/status`);
      assert.equal(res.status, 200);
      const body = await res.json() as { installed: boolean; running: boolean; plugin: { name: string } };
      assert.equal(body.installed, true);
      assert.equal(body.running, true);
      assert.equal(body.plugin.name, "Mock Plugin");
    });

    it("DELETE /api/plugins uninstalls the plugin", async () => {
      const res = await fetch(`${baseUrl}/api/plugins`, { method: "DELETE" });
      assert.equal(res.status, 200);
      assert.equal(registry.isInstalled(), false);
    });

    it("POST /api/plugins/reload reloads the plugin", async () => {
      // Re-install first
      await registry.installFromFile("");
      const res = await fetch(`${baseUrl}/api/plugins/reload`, { method: "POST" });
      assert.equal(res.status, 200);
      assert.equal(registry.isRunning(), true);
    });
  });
});
