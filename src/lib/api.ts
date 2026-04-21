const TMDB_IMG = "https://image.tmdb.org/t/p";

const img = (path: string | null, size = "w500"): string | null => (path ? `${TMDB_IMG}/${size}${path}` : null);
export const backdrop = (path: string | null): string | null => img(path, "original");
export const poster = (path: string | null, size = "w342"): string | null => img(path, size);
export const still = (path: string | null): string | null => img(path, "w300");
export const castProfile = (path: string | null): string | null => img(path, "w185");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function get(url: string): Promise<any> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  } catch (err) {
    if (err instanceof TypeError) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    }
    throw err;
  }
}

// ── Network recovery ─────────────────────────────────────────────
let _recoveryTimer: ReturnType<typeof setTimeout> | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    if (_recoveryTimer) clearTimeout(_recoveryTimer);
    _recoveryTimer = setTimeout(() => {
      _recoveryTimer = null;
      window.dispatchEvent(new Event("rattin-network-recovery"));
    }, 2000);
  });
}

export function fetchLanIp(): Promise<{ ip: string | null; port: number }> {
  return get("/api/rc/lan-ip");
}

export function fetchGenres(): Promise<{ genres: { id: number; name: string }[] }> {
  return get("/api/tmdb/genres");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchTrending(page = 1): Promise<any> {
  return get(`/api/tmdb/trending?page=${page}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchDiscover(type: string, genre: string | number, page = 1, sort = "popularity.desc", extra = ""): Promise<any> {
  return get(`/api/tmdb/discover?type=${type}&genre=${genre}&page=${page}&sort=${sort}${extra}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function searchTMDB(query: string, page = 1): Promise<any> {
  return get(`/api/tmdb/search?q=${encodeURIComponent(query)}&page=${page}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchMovie(id: string | number): Promise<any> {
  return get(`/api/tmdb/movie/${id}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchTV(id: string | number): Promise<any> {
  return get(`/api/tmdb/tv/${id}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchSeason(tvId: string | number, seasonNum: number): Promise<any> {
  return get(`/api/tmdb/tv/${tvId}/season/${seasonNum}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchEpisodeGroups(tvId: string | number): Promise<any> {
  return get(`/api/tmdb/tv/${tvId}/episode-groups`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function autoPlay(title: string, year: number | undefined, type: string, season?: number, episode?: number, imdbId?: string): Promise<any> {
  const res = await fetch("/api/auto-play", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, year, type, season, episode, imdbId }),
  });
  if (!res.ok) {
    const code = (await res.json().catch(() => ({} as Record<string, string>))).error;
    if (code === "not_found") throw new Error("not_found");
    throw new Error("stream_failed");
  }
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function searchStreams(title: string, year: number | undefined, type: string, season?: number, episode?: number, imdbId?: string): Promise<any[]> {
  const res = await fetch("/api/search-streams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, year, type, season, episode, imdbId }),
  });
  const data = await res.json();
  return data.results || [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function playTorrent(infoHash: string, name: string, season?: number | null, episode?: number | null, fileIdx?: number): Promise<any> {
  const res = await fetch("/api/play-torrent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ infoHash, name, season, episode, fileIdx }),
  });
  if (!res.ok) throw new Error("stream_failed");
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchLivePeers(infoHashes: string[]): Promise<Record<string, { numPeers: number; downloadSpeed: number }>> {
  const res = await fetch("/api/live-peers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ infoHashes }),
  });
  return res.json();
}

export async function checkAvailability(items: Array<{ id: number; title: string; year?: number; type: string }>): Promise<Set<number>> {
  const res = await fetch("/api/check-availability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const data = await res.json();
  return new Set(data.available || []);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchStatus(infoHash: string): Promise<any> {
  return get(`/api/status/${infoHash}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchDuration(infoHash: string, fileIndex: string | number): Promise<any> {
  return get(`/api/duration/${infoHash}/${fileIndex}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchSubtitleTracks(infoHash: string, fileIndex: string | number): Promise<any> {
  return get(`/api/subtitles/${infoHash}/${fileIndex}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchAudioTracks(infoHash: string, fileIndex: string | number): Promise<any> {
  return get(`/api/audio-tracks/${infoHash}/${fileIndex}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchReviews(type: string, id: string | number): Promise<any> {
  return get(`/api/reviews/${type}/${id}`);
}

interface IntroParams {
  tmdbId?: string;
  season?: string | number;
  episode?: string | number;
  title?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchIntroTimestamps(infoHash: string, fileIndex: string | number, { tmdbId, season, episode, title }: IntroParams = {}): Promise<any> {
  const params = new URLSearchParams();
  if (tmdbId) params.set("tmdbId", tmdbId);
  if (season) params.set("season", String(season));
  if (episode) params.set("episode", String(episode));
  if (title) params.set("title", title);
  const qs = params.toString();
  return get(`/api/intro/${infoHash}/${fileIndex}${qs ? `?${qs}` : ""}`);
}

// ── Cache ─────────────────────────────────────────────────────────

export function getCacheSize(): Promise<{ bytes: number; formatted: string }> {
  return get("/api/cache/size");
}

export async function clearCache(): Promise<void> {
  const res = await fetch("/api/cache", { method: "DELETE" });
  if (!res.ok) throw new Error("clear_failed");
}

export function getWatchHistoryCount(): Promise<{ count: number }> {
  return get("/api/watch-history/count");
}

export async function clearWatchHistory(): Promise<void> {
  const res = await fetch("/api/watch-history", { method: "DELETE" });
  if (!res.ok) throw new Error("clear_failed");
}

export function getSavedListCount(): Promise<{ count: number }> {
  return get("/api/saved/count");
}

export async function clearSavedList(): Promise<void> {
  const res = await fetch("/api/saved", { method: "DELETE" });
  if (!res.ok) throw new Error("clear_failed");
}

// ── Debrid ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getDebridStatus(): Promise<any> {
  return get("/api/debrid/status");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function verifyDebridKey(): Promise<any> {
  return get("/api/debrid/verify");
}

export async function setDebridConfig(apiKey: string, provider = "realdebrid", mode = "always"): Promise<void> {
  const res = await fetch("/api/debrid/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, provider, mode }),
  });
  if (!res.ok) throw new Error("config_failed");
}

export async function setDebridMode(mode: "always" | "cached"): Promise<void> {
  const res = await fetch("/api/debrid/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error("mode_failed");
}

export async function deleteDebridConfig(): Promise<void> {
  const res = await fetch("/api/debrid/config", { method: "DELETE" });
  if (!res.ok) throw new Error("delete_failed");
}

export async function checkDebridCached(infoHashes: string[]): Promise<Record<string, boolean>> {
  const res = await fetch("/api/debrid/cached", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ infoHashes }),
  });
  const data = await res.json();
  return data.cached || {};
}

// ── TMDB ──────────────────────────────────────────────────────────

export function getTmdbStatus(): Promise<{ configured: boolean }> {
  return get("/api/tmdb/status");
}

export async function setTmdbConfig(apiKey: string): Promise<void> {
  const res = await fetch("/api/tmdb/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "config_failed");
  }
}

export async function deleteTmdbConfig(): Promise<void> {
  const res = await fetch("/api/tmdb/config", { method: "DELETE" });
  if (!res.ok) throw new Error("delete_failed");
}

// ── Watch History ─────────────────────────────────────────────────

export async function reportWatchProgress(data: {
  tmdbId: number; mediaType: string; title: string; baseName?: string; posterPath: string | null;
  season?: number; episode?: number; episodeTitle?: string; seasonEpisodeCount?: number; seasonCount?: number;
  position: number; duration: number;
  imdbId?: string; year?: number;
}): Promise<void> {
  await fetch("/api/watch-history/progress", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchContinueWatching(): Promise<{ items: any[] }> {
  return get("/api/watch-history/continue");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchRecentlyWatched(): Promise<{ items: any[] }> {
  return get("/api/watch-history/recent");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchSeriesProgress(tmdbId: number): Promise<{ episodes: any[] }> {
  return get(`/api/watch-history/series/${tmdbId}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchResumePoint(tmdbId: number, mediaType: string): Promise<{ resumePoint: any }> {
  return get(`/api/watch-history/resume/${tmdbId}?mediaType=${mediaType}`);
}

export async function dismissWatchHistory(data: {
  tmdbId: number; mediaType: string; season?: number; episode?: number;
}): Promise<void> {
  await fetch("/api/watch-history/dismiss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ── Saved List ───────────────────────────────────────────────────

export async function toggleSaved(data: {
  tmdbId: number; mediaType: string; title: string; posterPath: string | null;
}): Promise<{ saved: boolean }> {
  const res = await fetch("/api/saved/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

export function checkSaved(mediaType: string, tmdbId: number): Promise<{ saved: boolean }> {
  return get(`/api/saved/${mediaType}/${tmdbId}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchSavedList(): Promise<{ items: any[] }> {
  return get("/api/saved");
}

// ── Update ────────────────────────────────────────────────────────

export interface UpdateRelease {
  version: string;
  name: string;
  body: string;
  url: string;
  date: string;
  assets: Array<{ name: string; url: string; size: number }>;
}

export interface UpdateInfo {
  available: boolean;
  current: string;
  latest: string;
  releases: UpdateRelease[];
}

export function checkForUpdate(): Promise<UpdateInfo> {
  return get("/api/update/check");
}

// ── VPN ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getVpnStatus(): Promise<any> {
  return get("/api/vpn/status");
}

export async function toggleVpn(action: "on" | "off"): Promise<void> {
  await fetch("/api/vpn/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function verifyVpn(): Promise<any> {
  return get("/api/vpn/verify");
}

export async function uploadSubtitle(file: File): Promise<{ url: string }> {
  const res = await fetch(`/api/subtitle/upload?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    body: file,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(data.error || "Upload failed");
  }
  return res.json();
}

export async function postLearnOffset(payload: {
  tmdbId: string; type: "outro"; offset_sec: number; season?: number; episode?: number;
}): Promise<void> {
  await fetch("/api/learn-offset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getLearnedOffset(tmdbId: string): Promise<{ outro_offset: number | null; sample_count: number }> {
  const res = await fetch(`/api/learn-offset/${encodeURIComponent(tmdbId)}`);
  return res.json();
}
