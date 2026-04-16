import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import crypto from "crypto";
import path from "path";
import { configDir } from "../storage/paths.js";

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
  /** RD: restricted download links for selected files */
  links?: string[];
  /** Provider torrent ID — for fetching individual file URLs on demand */
  torrentId?: string;
  /** Provider name — "realdebrid" or "torbox" */
  provider?: string;
}

export interface DebridProvider {
  name: string;
  unrestrict(magnetURI: string, fileIdx?: number): Promise<DebridStream>;
  checkCached(infoHashes: string[]): Promise<Map<string, boolean>>;
  /** Start downloading on RD without waiting — fire and forget to warm the cache */
  warmCache(magnetURI: string, fileIdx?: number): void;
  validateKey(): Promise<{ valid: boolean; premium: boolean; expiration: string | null; username: string | null }>;
}

export type DebridMode = "on" | "off";

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

interface TBFileInfo {
  id: number;
  name: string;
  size: number;
  short_name: string;
  mimetype: string;
}

interface TBTorrentInfo {
  id: number;
  hash: string;
  name: string;
  download_state: string;
  download_finished: boolean;
  files: TBFileInfo[];
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

export function saveConfig(provider: string, apiKey: string, mode: DebridMode = "on"): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify({ provider, apiKey, mode }), { mode: 0o600 });
}

export function getDebridMode(): DebridMode {
  const cfg = loadConfig();
  // Migrate old config values ("always"/"cached" → "on")
  const mode = cfg?.mode as string | undefined;
  if (!mode || mode === "always" || mode === "cached") return "on";
  return mode as DebridMode;
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
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(`${RD_BASE}${endpoint}`, {
          ...opts,
          headers: { ...this.headers(), ...opts.headers },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 401) throw new Error("debrid_auth_failed");
        if (res.status === 403) throw new Error("debrid_premium_required");
        if (res.status === 429) throw new Error("debrid_rate_limited");
        return res;
      } catch (err) {
        const msg = (err as Error).message || "";
        // Don't retry auth/permission errors
        if (msg.startsWith("debrid_")) throw err;
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        const cause = (err as Error).cause as { code?: string; message?: string } | undefined;
        const code = cause?.code || (err as Error).name || "unknown";
        const detail = cause?.message || msg || "fetch failed";
        throw new Error(`debrid_network_error: ${code} ${detail} (${endpoint})`);
      }
    }
    throw new Error("debrid_network_error: unreachable");
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

  async checkCached(_infoHashes: string[]): Promise<Map<string, boolean>> {
    // Real-Debrid removed /torrents/instantAvailability (error_code 37, "disabled_endpoint").
    // No replacement endpoint exists. Cache status can only be determined by attempting
    // to add the magnet — if it completes instantly, it was cached.
    return new Map();
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
        const info = await this.pollTorrentStatus(id, ["waiting_files_selection", "downloaded"], 10000);
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
        selectedRdId = parseInt(filesToSelect, 10); // first ID in comma-separated list (video)
        await this.rdFetch(`/torrents/selectFiles/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: this.formBody({ files: filesToSelect }),
        });

        // Step 4: Poll until downloaded
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
      // Links correspond to selected files ordered by ID — find the video's link
      const selectedFiles = info.files.filter(f => Number(f.selected)).sort((a, b) => a.id - b.id);
      const videoRdId = selectedRdId ?? selectedFiles.find(f => isVideoFile(f.path))?.id ?? selectedFiles[0]?.id;
      const videoLinkIdx = selectedFiles.findIndex(f => f.id === videoRdId);
      const videoLink = info.links[videoLinkIdx >= 0 ? videoLinkIdx : 0];

      const unRes = await this.rdFetch("/unrestrict/link", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: this.formBody({ link: videoLink }),
      });
      if (!unRes.ok) throw new Error("debrid_unrestrict_failed");

      const dl = await unRes.json() as { download: string; filename: string; filesize: number };
      // Convert RD's 1-based file ID to 0-based index
      const videoFileIndex = videoRdId ? videoRdId - 1 : 0;
      return {
        url: dl.download,
        filename: dl.filename,
        filesize: dl.filesize,
        fileIndex: videoFileIndex,
        files: allFiles,
        links: info.links || [],
        torrentId: id,
        provider: "realdebrid",
      };
    } catch (err) {
      // Clean up: delete the torrent from RD on failure
      try { await this.rdFetch(`/torrents/delete/${id}`, { method: "DELETE" }); } catch {}
      throw err;
    }
  }

  private pickFiles(files: RDTorrentInfo["files"], preferredIdx?: number): string {
    let videoId: number;
    if (preferredIdx !== undefined) {
      const target = files.find((f) => f.id === preferredIdx + 1); // RD uses 1-based IDs
      if (target && isVideoFile(target.path)) {
        videoId = target.id;
      } else {
        const videoFiles = files.filter((f) => isVideoFile(f.path));
        if (videoFiles.length === 0) return "all";
        videoId = videoFiles.reduce((a, b) => (b.bytes > a.bytes ? b : a)).id;
      }
    } else {
      const videoFiles = files.filter((f) => isVideoFile(f.path));
      if (videoFiles.length === 0) return "all";
      videoId = videoFiles.reduce((a, b) => (b.bytes > a.bytes ? b : a)).id;
    }
    // Also select subtitle files — they're tiny and needed for sub serving
    const subIds = files
      .filter((f) => isSubtitleFile(f.path))
      .map((f) => f.id);
    const ids = [videoId, ...subIds];
    return ids.join(",");
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

  /** Get an unrestricted download URL for a specific file in a torrent.
   *  Used for serving subtitle/audio files on demand.
   *  Subtitle files are selected alongside the video during initial unrestrict,
   *  so their links should already be available. */
  async getFileUrl(torrentId: string, fileId: number): Promise<string | null> {
    try {
      const info = await this.pollTorrentStatus(torrentId, ["downloaded"], 10000);
      if (!info.links || info.links.length === 0) return null;

      // Links correspond to selected files ordered by ID
      const selectedFiles = info.files.filter(f => Number(f.selected)).sort((a, b) => a.id - b.id);
      const linkIndex = selectedFiles.findIndex(f => f.id === fileId);
      if (linkIndex < 0 || linkIndex >= info.links.length) {
        console.warn("[SUB] Could not find link for file", { fileId, selectedCount: selectedFiles.length, linksCount: info.links.length });
        return null;
      }
      const link = info.links[linkIndex];
      const unRes = await this.rdFetch("/unrestrict/link", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: this.formBody({ link }),
      });
      if (!unRes.ok) {
        console.warn("[SUB] RD unrestrict failed", { status: unRes.status });
        return null;
      }
      const dl = await unRes.json() as { download: string };
      return dl.download;
    } catch (err) {
      console.error("[SUB] RD getFileUrl error", { error: (err as Error).message });
      return null;
    }
  }
}

// ── TorBox Provider ─────────────────────────────────────────────────

const TB_BASE = "https://api.torbox.app/v1/api";

class TorBoxProvider implements DebridProvider {
  name = "torbox";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async tbFetch(endpoint: string, opts: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${TB_BASE}${endpoint}`, {
      ...opts,
      headers: { ...this.headers(), ...opts.headers },
    });
    if (res.status === 401 || res.status === 403) throw new Error("debrid_auth_failed");
    if (res.status === 429) throw new Error("debrid_rate_limited");
    return res;
  }

  async validateKey(): Promise<{ valid: boolean; premium: boolean; expiration: string | null; username: string | null }> {
    try {
      const res = await this.tbFetch("/user/me");
      if (!res.ok) return { valid: false, premium: false, expiration: null, username: null };
      const { data } = await res.json() as { data: { plan: number; premium_expires_at: string; email: string } };
      return {
        valid: true,
        premium: data.plan > 0,
        expiration: data.premium_expires_at || null,
        username: data.email || null,
      };
    } catch {
      return { valid: false, premium: false, expiration: null, username: null };
    }
  }

  async checkCached(infoHashes: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (infoHashes.length === 0) return result;

    // Batch up to 50 hashes per request (keep URL under ~2048 chars)
    const batches: string[][] = [];
    for (let i = 0; i < infoHashes.length; i += 50) {
      batches.push(infoHashes.slice(i, i + 50));
    }

    for (const batch of batches) {
      try {
        const hashParam = batch.map((h) => h.toLowerCase()).join(",");
        const res = await this.tbFetch(`/torrents/checkcached?hash=${hashParam}&format=object`);
        if (!res.ok) {
          for (const h of batch) result.set(h.toLowerCase(), false);
          continue;
        }
        const { data } = await res.json() as { data: Record<string, unknown> | null };
        for (const h of batch) {
          const entry = data?.[h.toLowerCase()];
          result.set(h.toLowerCase(), !!entry);
        }
      } catch {
        for (const h of batch) result.set(h.toLowerCase(), false);
      }
    }
    return result;
  }

  warmCache(magnetURI: string, _fileIdx?: number): void {
    // Fire-and-forget: add magnet to TorBox so it starts downloading
    this.tbFetch("/torrents/createtorrent", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ magnet: magnetURI }),
    }).catch(() => {});
  }

  async unrestrict(magnetURI: string, fileIdx?: number): Promise<DebridStream> {
    // Step 1: Add magnet
    const addRes = await this.tbFetch("/torrents/createtorrent", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ magnet: magnetURI }),
    });
    if (!addRes.ok) {
      const err = await addRes.json().catch(() => ({})) as { detail?: string };
      throw new Error(`debrid_add_failed: ${err.detail || addRes.status}`);
    }
    const { data: addData } = await addRes.json() as { data: { torrent_id: number; hash: string } };
    const torrentId = addData.torrent_id;

    try {
      // Step 2: Poll until download_finished is true
      const torrent = await this.pollTorrentReady(torrentId, 30000);

      // Step 3: Pick the video file
      const allFiles: DebridFileInfo[] = torrent.files.map((f: TBFileInfo) => ({
        id: f.id,
        path: f.name,
        bytes: f.size,
      }));

      const videoFile = this.pickFile(torrent.files, fileIdx);
      if (!videoFile) throw new Error("debrid_no_links");

      // Step 4: Get download link — TorBox uses token query param, not Bearer header
      const dlRes = await fetch(
        `${TB_BASE}/torrents/requestdl?token=${encodeURIComponent(this.apiKey)}&torrent_id=${torrentId}&file_id=${videoFile.id}`,
      );
      if (!dlRes.ok) throw new Error("debrid_unrestrict_failed");
      const { data: dlUrl } = await dlRes.json() as { data: string };

      return {
        url: dlUrl,
        filename: videoFile.short_name || videoFile.name,
        filesize: videoFile.size,
        fileIndex: fileIdx ?? allFiles.findIndex((f) => f.id === videoFile.id),
        files: allFiles,
        torrentId: String(torrentId),
        provider: "torbox",
      };
    } catch (err) {
      // Clean up on failure — delete the torrent
      try {
        await this.tbFetch("/torrents/controltorrent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ torrent_id: torrentId, operation: "delete" }),
        });
      } catch {}
      throw err;
    }
  }

  private pickFile(files: TBFileInfo[], preferredIdx?: number): TBFileInfo | null {
    if (preferredIdx !== undefined) {
      const target = files.find((f) => f.id === preferredIdx);
      if (target && isVideoFile(target.name)) return target;
    }
    const videoFiles = files.filter((f) => isVideoFile(f.name));
    if (videoFiles.length === 0) return null;
    return videoFiles.reduce((a, b) => (b.size > a.size ? b : a));
  }

  private async pollTorrentReady(torrentId: number, timeoutMs: number): Promise<TBTorrentInfo> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const res = await this.tbFetch(`/torrents/mylist?bypass_cache=true&id=${torrentId}`);
      if (!res.ok) throw new Error("debrid_poll_failed");
      const { data } = await res.json() as { data: TBTorrentInfo | null };
      if (!data) throw new Error("debrid_poll_failed");

      if (data.download_finished) return data;

      const state = data.download_state;
      const errorStates = ["stalled (no seeds)", "paused", "error", "failed"];
      if (errorStates.includes(state)) {
        throw new Error(`debrid_torrent_${state.replace(/\s+/g, "_")}`);
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    throw new Error("debrid_timeout");
  }

  /** Get a direct download URL for a specific file in a TorBox torrent. */
  async getFileDownloadUrl(torrentId: number, fileId: number): Promise<string | null> {
    try {
      const res = await this.tbFetch(`/torrents/requestdl?token=${encodeURIComponent(this.apiKey)}&torrent_id=${torrentId}&file_id=${fileId}`);
      if (!res.ok) return null;
      const { data } = await res.json() as { data: string };
      return data;
    } catch {
      return null;
    }
  }
}

function isVideoFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".mpg", ".mpeg"].includes(ext);
}

function isSubtitleFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".srt", ".ass", ".ssa", ".vtt", ".sub"].includes(ext);
}

// ── Active debrid stream state ───────────────────────────────────
// Keyed by infoHash — set when a debrid stream starts.

interface ActiveDebridStream {
  url: string;
  files: DebridFileInfo[];
  streamKey: string;
  /** RD: restricted download links for selected files; TB: not used */
  links?: string[];
  /** Provider torrent ID — for fetching individual file URLs on demand */
  torrentId?: string;
  /** Provider name — "realdebrid" or "torbox" */
  provider?: string;
}

const _activeDebridStreams = new Map<string, ActiveDebridStream>();
const _activeDebridKeys = new Map<string, string>();

export function setActiveDebridStream(infoHash: string, url: string, files: DebridFileInfo[], links?: string[], torrentId?: string, provider?: string): string {
  const normalized = infoHash.toLowerCase();
  const previous = _activeDebridStreams.get(normalized);
  if (previous) _activeDebridKeys.delete(previous.streamKey);

  const streamKey = crypto.randomBytes(16).toString("hex");
  _activeDebridStreams.set(normalized, { url, files, streamKey, links, torrentId, provider });
  _activeDebridKeys.set(streamKey, normalized);
  return streamKey;
}

export function getActiveDebridUrl(infoHash: string, fileIndex: number): string | null {
  return _activeDebridStreams.get(infoHash.toLowerCase())?.url || null;
}

export function getActiveDebridFiles(infoHash: string): DebridFileInfo[] {
  return _activeDebridStreams.get(infoHash.toLowerCase())?.files || [];
}

export function getActiveDebridStreamByKey(streamKey: string): ActiveDebridStream | null {
  const infoHash = _activeDebridKeys.get(streamKey);
  if (!infoHash) return null;
  return _activeDebridStreams.get(infoHash) || null;
}

/** Get an unrestricted download URL for a specific file in an active debrid stream.
 *  Used to serve subtitle/audio files that aren't the main video. */
export async function getDebridFileUrl(infoHash: string, fileId: number): Promise<string | null> {
  const normalized = infoHash.toLowerCase();
  const stream = _activeDebridStreams.get(normalized);
  if (!stream) return null;

  // Check if the requested file is the main video (already unrestricted)
  const isVideo = stream.url && _isVideoByExtension(stream.files, fileId);
  if (isVideo) return stream.url;

  const provider = getDebridProvider();
  if (!provider) return null;

  if (stream.provider === "realdebrid" && stream.torrentId) {
    // Reuse the singleton provider instance
    const rd = provider as RealDebridProvider;
    return rd.getFileUrl(stream.torrentId, fileId);
  }

  if (stream.provider === "torbox" && stream.torrentId) {
    return await (provider as TorBoxProvider).getFileDownloadUrl(Number(stream.torrentId), fileId);
  }

  return null;
}

function _isVideoByExtension(files: DebridFileInfo[], fileId: number): boolean {
  const file = files.find(f => f.id === fileId);
  if (!file) return false;
  return isVideoFile(file.path);
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
  } else if (cfg && cfg.provider === "torbox" && cfg.apiKey) {
    _provider = new TorBoxProvider(cfg.apiKey);
  } else {
    _provider = null;
  }
}
