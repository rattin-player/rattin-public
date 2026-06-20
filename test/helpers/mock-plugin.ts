// test/helpers/mock-plugin.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  SearchQuery, SearchResult, PluginIndexEntry, PluginStatus,
  AvailabilityItem, AvailabilityResult, PluginRegistry,
} from "../../lib/plugins/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "..", "fixtures");
const devKeyJson = JSON.parse(
  readFileSync(path.join(fixtureDir, "dev-private-key.json"), "utf8")
) as { base64: string; format: "der"; type: "pkcs8" };

function signWithDevKey(data: Buffer): Buffer {
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(devKeyJson.base64, "base64"),
    format: devKeyJson.format,
    type: devKeyJson.type,
  });
  return crypto.sign(null, data, privKey);
}

/**
 * A mock PluginRegistry that returns predefined results without spawning a process.
 * Used by route tests and search tests that need plugin results.
 */
export class MockPluginRegistry implements PluginRegistry {
  private installed = false;
  private running = false;
  private meta: { id: string; name: string; version: string } | null = null;

  constructor(opts: { installed?: boolean; running?: boolean } = {}) {
    this.installed = opts.installed ?? false;
    this.running = opts.running ?? false;
    if (this.installed) {
      this.meta = { id: "mock", name: "Mock Plugin", version: "1.0.0" };
    }
  }

  isInstalled(): boolean { return this.installed; }
  isRunning(): boolean { return this.running; }
  getStatus(): PluginStatus {
    return {
      installed: this.installed,
      plugin: this.meta,
      sourceUrl: this.meta ? "https://mock.example.com/plugin.js" : null,
      running: this.running,
    };
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    if (!this.running) throw new Error("Plugin not running");
    return [{
      infoHash: "abc123def456",
      name: `${query.query}.1080p.WEB-DL`,
      size: 1000000000,
      seeders: 100,
      source: "mock",
    }];
  }

  async searchBatch(queries: SearchQuery[]): Promise<SearchResult[][]> {
    if (!this.running) throw new Error("Plugin not running");
    return queries.map((q) => [{
      infoHash: `hash-${q.query.replace(/\s/g, "").slice(0, 8)}`,
      name: `${q.query}.1080p.WEB-DL`,
      size: 1000000000,
      seeders: 100,
      source: "mock",
    }]);
  }

  async availability(items: AvailabilityItem[]): Promise<AvailabilityResult> {
    if (!this.running) throw new Error("Plugin not running");
    return { available: items.map((_, i) => i) };
  }

  async installFromUrl(_url: string, _entry: PluginIndexEntry): Promise<void> {
    this.installed = true;
    this.running = true;
    this.meta = { id: "mock", name: "Mock Plugin", version: "1.0.0" };
  }

  async installFromUrlSimple(_url: string): Promise<void> {
    this.installed = true;
    this.running = true;
    this.meta = { id: "mock", name: "Mock Plugin", version: "1.0.0" };
  }

  async installFromFile(_filePath: string): Promise<void> {
    this.installed = true;
    this.running = true;
    this.meta = { id: "mock", name: "Mock Plugin", version: "1.0.0" };
  }

  async reload(): Promise<void> {
    if (this.installed) this.running = true;
  }

  async uninstall(): Promise<void> {
    this.installed = false;
    this.running = false;
    this.meta = null;
  }

  stop(): void {
    this.running = false;
  }
}
