// lib/plugins/registry.ts
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { LogFn } from "../types.js";
import type {
  SearchQuery, SearchResult, PluginIndexEntry, PluginStatus,
  PluginHealth, AvailabilityItem, AvailabilityResult, PluginRegistry,
} from "./types.js";
import { pluginDir as defaultPluginDir, pluginMetaPath as defaultMetaPath } from "./plugin-paths.js";
import { verifyPluginSignature } from "./signing.js";

export interface PluginRegistryDeps {
  log: LogFn;
  pluginDir?: string;
  allowUnsigned?: boolean;
  /** Override the restart backoff delay for testing (ms). Default: exponential 2^n seconds. */
  restartDelayOverride?: number;
}

interface StoredMeta {
  id: string;
  name: string;
  version: string;
  sourceUrl?: string;
}

export class PluginRegistryImpl implements PluginRegistry {
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private secret: string | null = null;
  private meta: StoredMeta | null = null;
  private restartAttempts = 0;
  private stopped = false;
  private spawnPromise: Promise<void> | null = null;
  private readonly deps: PluginRegistryDeps;
  private readonly dir: string;
  private readonly filePath: string;
  private readonly metaPath: string;
  private readonly allowUnsigned: boolean;
  private readonly restartDelayOverride?: number;

  constructor(deps: PluginRegistryDeps) {
    this.deps = deps;
    this.dir = deps.pluginDir || defaultPluginDir();
    this.filePath = path.join(this.dir, "plugin.js");
    this.metaPath = path.join(this.dir, "plugin-meta.json");
    this.allowUnsigned = deps.allowUnsigned ?? false;
    this.restartDelayOverride = deps.restartDelayOverride;
    // Load existing meta from disk (if plugin was previously installed)
    this.meta = this.loadMeta();
  }

  // ── Status ──────────────────────────────────────────────────────

  isInstalled(): boolean {
    return this.meta !== null && existsSync(this.filePath);
  }

  isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  getStatus(): PluginStatus {
    return {
      installed: this.isInstalled(),
      plugin: this.meta ? { id: this.meta.id, name: this.meta.name, version: this.meta.version } : null,
      sourceUrl: this.meta?.sourceUrl ?? null,
      running: this.isRunning(),
    };
  }

  // ── Install ─────────────────────────────────────────────────────

  async installFromUrl(url: string, entry: PluginIndexEntry): Promise<void> {
    this.deps.log("info", "Installing plugin from URL", { url, version: entry.version });
    const content = await this.downloadPlugin(url);
    // Verify SHA256 (secondary integrity check)
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    if (entry.sha256 && hash !== entry.sha256) {
      throw new Error(`SHA256 mismatch: expected ${entry.sha256}, got ${hash}`);
    }
    // Verify signature (primary trust gate)
    const signature = await this.downloadSignature(url);
    if (!signature || !verifyPluginSignature(content, signature)) {
      if (!this.allowUnsigned) {
        throw new Error("Plugin signature verification failed — plugin is not signed by a trusted publisher");
      }
      this.deps.log("warn", "Allowing unsigned plugin (developer mode)", { url });
    }
    await this.saveAndSpawn(content, {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      sourceUrl: url,
    });
  }

  async installFromUrlSimple(url: string): Promise<void> {
    this.deps.log("info", "Installing plugin from URL (simple)", { url });
    const content = await this.downloadPlugin(url);
    // Verify signature (primary trust gate)
    const signature = await this.downloadSignature(url);
    if (!signature || !verifyPluginSignature(content, signature)) {
      if (!this.allowUnsigned) {
        throw new Error("Plugin signature verification failed — plugin is not signed by a trusted publisher");
      }
      this.deps.log("warn", "Allowing unsigned plugin (developer mode)", { url });
    }
    // Save and spawn temporarily to get health info
    await this.killProcess();
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.filePath, content);
    await this.spawnProcess(this.filePath);
    const health = await this.healthCheck();
    this.meta = {
      id: health?.id || "unknown",
      name: health?.name || "Plugin",
      version: health?.version || "0.0.0",
      sourceUrl: url,
    };
    this.saveMeta();
    // Already spawned, we're done
  }

  async installFromFile(filePath: string): Promise<void> {
    if (!this.allowUnsigned) {
      throw new Error("Unsigned plugin install requires developer mode");
    }
    this.deps.log("info", "Installing plugin from file (dev mode)", { filePath });
    const content = readFileSync(filePath);
    // Try to get health info from the plugin to extract its name/version
    const tempPath = path.join(this.dir, "plugin.js");
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(tempPath, content);
    // Spawn temporarily to get health info
    await this.spawnProcess(tempPath);
    const health = await this.healthCheck();
    await this.killProcess();
    this.meta = {
      id: health?.id || "local",
      name: health?.name || "Local Plugin",
      version: health?.version || "0.0.0",
      sourceUrl: filePath,
    };
    this.saveMeta();
    // Re-spawn as the real plugin
    await this.spawnProcess(this.filePath);
  }

  // ── Search proxy ────────────────────────────────────────────────

  async search(query: SearchQuery): Promise<SearchResult[]> {
    if (!this.isRunning()) await this.ensureRunning();
    return this.request<SearchResult[]>("/search", query);
  }

  async searchBatch(queries: SearchQuery[]): Promise<SearchResult[][]> {
    if (!this.isRunning()) await this.ensureRunning();
    return this.request<SearchResult[][]>("/search-batch", { queries });
  }

  async availability(items: AvailabilityItem[]): Promise<AvailabilityResult> {
    if (!this.isRunning()) await this.ensureRunning();
    return this.request<AvailabilityResult>("/availability", { items });
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async reload(): Promise<void> {
    await this.killProcess();
    this.stopped = false;
    if (this.isInstalled()) {
      await this.spawnProcess(this.filePath);
    }
  }

  async uninstall(): Promise<void> {
    await this.killProcess();
    this.meta = null;
    try { unlinkSync(this.filePath); } catch {}
    try { unlinkSync(this.metaPath); } catch {}
    this.deps.log("info", "Plugin uninstalled");
  }

  stop(): void {
    this.stopped = true;
    this.killProcess();
  }

  /** Test-only: kill the process without setting stopped=true, simulating a crash. */
  killProcessForTest(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.port = null;
    // Don't set stopped=true — we want the exit handler to trigger scheduleRestart
    try { proc.kill("SIGKILL"); } catch {}
  }

  // ── Internal: process management ────────────────────────────────

  private async saveAndSpawn(content: Buffer, meta: StoredMeta): Promise<void> {
    // Kill existing process if running
    await this.killProcess();
    // Save plugin file
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.filePath, content);
    // Save metadata
    this.meta = meta;
    this.saveMeta();
    // Spawn
    await this.spawnProcess(this.filePath);
  }

  private async spawnProcess(pluginPath: string): Promise<void> {
    this.secret = crypto.randomBytes(32).toString("hex");
    this.port = null;
    this.stopped = false;

    const nodeBinary = process.env.MAGNET_NODE_PATH || "node";
    const proc = spawn(nodeBinary, [pluginPath], {
      env: {
        ...process.env,
        RATTIN_PLUGIN_PORT: "0",
        RATTIN_PLUGIN_SECRET: this.secret,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc = proc;

    // Read port from stdout (first JSON line)
    const portPromise = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Plugin did not report port within 10s")), 10000);
      proc.stdout!.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as { port: number };
            if (typeof parsed.port === "number") {
              clearTimeout(timeout);
              resolve(parsed.port);
              return;
            }
          } catch { /* not JSON, ignore */ }
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      proc.on("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Plugin process exited before reporting port"));
      });
    });

    // Pipe stderr to log
    proc.stderr!.on("data", (data: Buffer) => {
      this.deps.log("warn", "Plugin stderr", { msg: data.toString().trim() });
    });

    // Handle crash with backoff restart
    proc.on("exit", (code) => {
      if (this.stopped) return;
      this.deps.log("warn", "Plugin process exited", { code, attempts: this.restartAttempts });
      this.proc = null;
      this.port = null;
      this.scheduleRestart();
    });

    try {
      this.port = await portPromise;
      this.restartAttempts = 0;
      this.deps.log("info", "Plugin started", { port: this.port });
    } catch (err) {
      this.proc = null;
      throw err;
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || !this.isInstalled()) return;
    if (this.restartAttempts >= 5) {
      this.deps.log("err", "Plugin restart limit reached (5 attempts), giving up");
      return;
    }
    this.restartAttempts++;
    const delay = this.restartDelayOverride ?? Math.min(1000 * 2 ** this.restartAttempts, 30000);
    this.deps.log("info", "Scheduling plugin restart", { delay, attempt: this.restartAttempts });
    setTimeout(() => {
      if (this.stopped) return;
      if (this.spawnPromise) return; // another spawn already in progress
      this.spawnPromise = this.spawnProcess(this.filePath)
        .catch((err) => {
          this.deps.log("err", "Plugin restart failed", { error: (err as Error).message });
        })
        .finally(() => { this.spawnPromise = null; });
    }, delay);
  }

  private async killProcess(): Promise<void> {
    this.stopped = true;
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.port = null;
    return new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      try { proc.kill("SIGTERM"); } catch { resolve(); }
      // Force kill after 5s
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
        resolve();
      }, 5000);
    });
  }

  private async ensureRunning(): Promise<void> {
    if (this.isRunning()) return;
    if (!this.isInstalled()) throw new Error("No plugin installed");
    // If a spawn is already in progress (e.g. two concurrent search requests
    // arriving while the plugin is down), wait for it instead of spawning twice
    if (this.spawnPromise) return this.spawnPromise;
    this.stopped = false;
    this.spawnPromise = this.spawnProcess(this.filePath)
      .then(() => { this.healthCheck(); })
      .finally(() => { this.spawnPromise = null; });
    return this.spawnPromise;
  }

  private async healthCheck(): Promise<PluginHealth | null> {
    if (!this.port || !this.secret) return null;
    try {
      const resp = await fetch(`http://127.0.0.1:${this.port}/health`, {
        headers: { Authorization: `Bearer ${this.secret}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return null;
      return await resp.json() as PluginHealth;
    } catch {
      return null;
    }
  }

  // ── Internal: HTTP requests to plugin ───────────────────────────

  private async request<T>(path: string, body: unknown): Promise<T> {
    if (!this.port || !this.secret) {
      throw new Error("Plugin not running");
    }
    const resp = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.secret}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Plugin ${path} returned ${resp.status}: ${text}`);
    }
    return await resp.json() as T;
  }

  // ── Internal: download helpers ──────────────────────────────────

  private async downloadPlugin(url: string): Promise<Buffer> {
    if (url.startsWith("file://")) {
      return readFileSync(url.slice("file://".length));
    }
    const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  /**
   * Download the .sig companion file for a plugin.
   * The CDN must serve both the plugin `.js` and its `.js.sig` signature file
   * at the same path prefix. The build pipeline in the private plugin repo
   * uploads both files. If the .sig file is missing (e.g. unsigned plugin
   * in dev mode), returns null.
   */
  private async downloadSignature(pluginUrl: string): Promise<Buffer | null> {
    const sigUrl = pluginUrl + ".sig";
    try {
      if (pluginUrl.startsWith("file://")) {
        const sigPath = pluginUrl.slice("file://".length) + ".sig";
        if (existsSync(sigPath)) return readFileSync(sigPath);
        return null;
      }
      const resp = await fetch(sigUrl, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer());
    } catch {
      return null;
    }
  }

  // ── Internal: metadata persistence ──────────────────────────────

  private loadMeta(): StoredMeta | null {
    try {
      const raw = readFileSync(this.metaPath, "utf8");
      return JSON.parse(raw) as StoredMeta;
    } catch {
      return null;
    }
  }

  private saveMeta(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.metaPath, JSON.stringify(this.meta));
    } catch (err) {
      this.deps.log("warn", "Failed to save plugin meta", { error: (err as Error).message });
    }
  }
}

/**
 * Factory function for creating a PluginRegistry instance.
 * Used by server.ts to create the singleton registry.
 */
export function createPluginRegistry(deps: PluginRegistryDeps): PluginRegistryImpl {
  return new PluginRegistryImpl(deps);
}
