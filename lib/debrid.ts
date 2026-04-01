import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import path from "path";
import { configDir } from "./paths.js";

// ── Types ────────────────────────────────────────────────────────────

export interface DebridFileInfo {
  id: number;
  path: string;
  bytes: number;
}

export interface DebridStream {
  url: string;
  filename: string;
  filesize: number;
  fileIndex: number;  // 0-based index of the selected video file in the torrent
  files: DebridFileInfo[];
}

export interface DebridProvider {
  name: string;
  unrestrict(magnetURI: string, fileIdx?: number): Promise<DebridStream>;
  checkCached(infoHashes: string[]): Promise<Map<string, boolean>>;
  /** Start downloading on RD without waiting — fire and forget to warm the cache */
  warmCache(magnetURI: string, fileIdx?: number): void;
  validateKey(): Promise<{ valid: boolean; premium: boolean; expiration: string | null; username: string | null }>;
}

export type DebridMode = "always" | "cached";

interface DebridConfig {
  provider: string;
  apiKey: string;
  mode?: DebridMode;
}

interface RDTorrentInfo {
  id: string;
  status: string;
  files: { id: number; path: string; bytes: number; selected: number }[];
  links: string[];
  progress: number;
}

// ── Config ───────────────────────────────────────────────────────────

const CONFIG_DIR = configDir();
const CONFIG_PATH = path.join(CONFIG_DIR, "debrid.json");

export function loadConfig(): DebridConfig | null {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw) as DebridConfig;
    if (cfg.provider && cfg.apiKey) return cfg;
    return null;
  } catch {
    return null;
  }
}

export function saveConfig(provider: string, apiKey: string, mode: DebridMode = "always"): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify({ provider, apiKey, mode }), { mode: 0o600 });
}

export function getDebridMode(): DebridMode {
  const cfg = loadConfig();
  return cfg?.mode || "always";
}

export function deleteConfig(): void {
  try { unlinkSync(CONFIG_PATH); } catch {}
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

// ── Real-Debrid Provider ─────────────────────────────────────────────

const RD_BASE = "https://api.real-debrid.com/rest/1.0";

class RealDebridProvider implements DebridProvider {
  name = "realdebrid";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async rdFetch(endpoint: string, opts: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${RD_BASE}${endpoint}`, {
      ...opts,
      headers: { ...this.headers(), ...opts.headers },
    });
    if (res.status === 401) throw new Error("debrid_auth_failed");
    if (res.status === 403) throw new Error("debrid_premium_required");
    if (res.status === 429) throw new Error("debrid_rate_limited");
    return res;
  }

  private formBody(params: Record<string, string>): URLSearchParams {
    return new URLSearchParams(params);
  }

  async validateKey(): Promise<{ valid: boolean; premium: boolean; expiration: string | null; username: string | null }> {
    try {
      const res = await this.rdFetch("/user");
      if (!res.ok) return { valid: false, premium: false, expiration: null, username: null };
      const data = await res.json() as { type: string; expiration: string; username: string };
      return {
        valid: true,
        premium: data.type === "premium",
        expiration: data.expiration || null,
        username: data.username || null,
      };
    } catch {
      return { valid: false, premium: false, expiration: null, username: null };
    }
  }

  async checkCached(infoHashes: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (infoHashes.length === 0) return result;

    // Batch up to 50 hashes per request
    const batches: string[][] = [];
    for (let i = 0; i < infoHashes.length; i += 50) {
      batches.push(infoHashes.slice(i, i + 50));
    }

    for (const batch of batches) {
      try {
        const hashPath = batch.map((h) => h.toLowerCase()).join("/");
        const res = await this.rdFetch(`/torrents/instantAvailability/${hashPath}`);
        if (!res.ok) {
          for (const h of batch) result.set(h.toLowerCase(), false);
          continue;
        }
        const data = await res.json() as Record<string, { rd?: Record<string, { filename: string; filesize: number }>[] }>;
        for (const h of batch) {
          const entry = data[h.toLowerCase()];
          const cached = !!(entry && entry.rd && entry.rd.length > 0);
          result.set(h.toLowerCase(), cached);
        }
      } catch {
        for (const h of batch) result.set(h.toLowerCase(), false);
      }
    }
    return result;
  }

  warmCache(magnetURI: string, fileIdx?: number): void {
    // Fire-and-forget: add magnet to RD so it starts downloading.
    // Next time this torrent is played, it'll be cached and instant.
    this.rdFetch("/torrents/addMagnet", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: this.formBody({ magnet: magnetURI }),
    }).then(async (addRes) => {
      if (!addRes.ok) return;
      const { id } = await addRes.json() as { id: string };
      // Poll briefly for file selection, then select and let RD download
      try {
        const info = await this.pollTorrentStatus(id, ["waiting_files_selection", "downloaded"], 15000);
        if (info.status === "waiting_files_selection") {
          const files = this.pickFiles(info.files, fileIdx);
          await this.rdFetch(`/torrents/selectFiles/${id}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: this.formBody({ files }),
          });
        }
        // Don't wait for download — RD will keep downloading in the background
      } catch { /* ignore — best effort cache warming */ }
    }).catch(() => {});
  }

  async unrestrict(magnetURI: string, fileIdx?: number): Promise<DebridStream> {
    // Step 1: Add magnet
    const addRes = await this.rdFetch("/torrents/addMagnet", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: this.formBody({ magnet: magnetURI }),
    });
    if (!addRes.ok) {
      const err = await addRes.json().catch(() => ({})) as { error?: string };
      throw new Error(`debrid_add_failed: ${err.error || addRes.status}`);
    }
    const { id } = await addRes.json() as { id: string };

    try {
      // Step 2: Poll until waiting_files_selection or downloaded
      let info = await this.pollTorrentStatus(id, ["waiting_files_selection", "downloaded"], 30000);

      // Step 3: Select files if needed
      let selectedRdId: number | null = null;
      if (info.status === "waiting_files_selection") {
        const filesToSelect = this.pickFiles(info.files, fileIdx);
        selectedRdId = parseInt(filesToSelect, 10); // first ID in comma-separated list
        await this.rdFetch(`/torrents/selectFiles/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: this.formBody({ files: filesToSelect }),
        });

        // Step 4: Poll until downloaded — give it 30s for near-cached content
        info = await this.pollTorrentStatus(id, ["downloaded"], 30000);
      }

      if (!info.links || info.links.length === 0) {
        throw new Error("debrid_no_links");
      }

      // Store the full file list for status/subtitle discovery
      const allFiles: DebridFileInfo[] = info.files.map((f) => ({
        id: f.id,
        path: f.path,
        bytes: f.bytes,
      }));

      // Step 5: Unrestrict the video link
      const unRes = await this.rdFetch("/unrestrict/link", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: this.formBody({ link: info.links[0] }),
      });
      if (!unRes.ok) throw new Error("debrid_unrestrict_failed");

      const dl = await unRes.json() as { download: string; filename: string; filesize: number };
      // Convert RD's 1-based file ID to 0-based index
      const videoFileIndex = selectedRdId ? selectedRdId - 1 : 0;
      return {
        url: dl.download,
        filename: dl.filename,
        filesize: dl.filesize,
        fileIndex: videoFileIndex,
        files: allFiles,
      };
    } catch (err) {
      // Clean up: delete the torrent from RD on failure
      try { await this.rdFetch(`/torrents/delete/${id}`, { method: "DELETE" }); } catch {}
      throw err;
    }
  }

  private pickFiles(files: RDTorrentInfo["files"], preferredIdx?: number): string {
    if (preferredIdx !== undefined) {
      const target = files.find((f) => f.id === preferredIdx + 1); // RD uses 1-based IDs
      if (target && isVideoFile(target.path)) return String(target.id);
    }
    const videoFiles = files.filter((f) => isVideoFile(f.path));
    if (videoFiles.length === 0) return "all";
    const largest = videoFiles.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    return String(largest.id);
  }

  private async pollTorrentStatus(id: string, targetStatuses: string[], timeoutMs: number): Promise<RDTorrentInfo> {
    const deadline = Date.now() + timeoutMs;
    const errorStatuses = ["magnet_error", "error", "virus", "dead"];

    while (Date.now() < deadline) {
      const res = await this.rdFetch(`/torrents/info/${id}`);
      if (!res.ok) throw new Error("debrid_poll_failed");
      const info = await res.json() as RDTorrentInfo;

      if (targetStatuses.includes(info.status)) return info;
      if (errorStatuses.includes(info.status)) {
        throw new Error(`debrid_torrent_${info.status}`);
      }

      // Wait before polling again — 1s for short timeouts, 2s for longer
      await new Promise((r) => setTimeout(r, timeoutMs <= 30000 ? 1000 : 2000));
    }

    throw new Error("debrid_timeout");
  }
}

function isVideoFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".mpg", ".mpeg"].includes(ext);
}

// ── Active debrid stream state ───────────────────────────────────
// Keyed by infoHash — set when a debrid stream starts.

interface ActiveDebridStream {
  url: string;
  files: DebridFileInfo[];
}

const _activeDebridStreams = new Map<string, ActiveDebridStream>();

export function setActiveDebridStream(infoHash: string, url: string, files: DebridFileInfo[]): void {
  _activeDebridStreams.set(infoHash.toLowerCase(), { url, files });
}

export function getActiveDebridUrl(infoHash: string, fileIndex: number): string | null {
  return _activeDebridStreams.get(infoHash.toLowerCase())?.url || null;
}

export function getActiveDebridFiles(infoHash: string): DebridFileInfo[] {
  return _activeDebridStreams.get(infoHash.toLowerCase())?.files || [];
}

let _provider: DebridProvider | null | undefined; // undefined = not loaded yet

export function getDebridProvider(): DebridProvider | null {
  if (_provider === undefined) reloadDebridProvider();
  return _provider || null;
}

export function reloadDebridProvider(): void {
  const cfg = loadConfig();
  if (cfg && cfg.provider === "realdebrid" && cfg.apiKey) {
    _provider = new RealDebridProvider(cfg.apiKey);
  } else {
    _provider = null;
  }
}
