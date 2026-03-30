const TMDB_IMG = "https://image.tmdb.org/t/p";

const img = (path, size = "w500") => (path ? `${TMDB_IMG}/${size}${path}` : null);
export const backdrop = (path) => img(path, "original");
export const poster = (path, size = "w342") => img(path, size);
export const still = (path) => img(path, "w300");

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function fetchTrending(page = 1) {
  return get(`/api/tmdb/trending?page=${page}`);
}

export function fetchDiscover(type, genre, page = 1, sort = "popularity.desc", extra = "") {
  return get(`/api/tmdb/discover?type=${type}&genre=${genre}&page=${page}&sort=${sort}${extra}`);
}

export function searchTMDB(query, page = 1) {
  return get(`/api/tmdb/search?q=${encodeURIComponent(query)}&page=${page}`);
}

export function fetchMovie(id) {
  return get(`/api/tmdb/movie/${id}`);
}

export function fetchTV(id) {
  return get(`/api/tmdb/tv/${id}`);
}

export function fetchSeason(tvId, seasonNum) {
  return get(`/api/tmdb/tv/${tvId}/season/${seasonNum}`);
}

export async function autoPlay(title, year, type, season, episode, imdbId) {
  const res = await fetch("/api/auto-play", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, year, type, season, episode, imdbId }),
  });
  if (!res.ok) {
    const code = (await res.json().catch(() => ({}))).error;
    if (code === "not_found") throw new Error("not_found");
    throw new Error("stream_failed");
  }
  return res.json();
}

export async function searchStreams(title, year, type, season, episode, imdbId) {
  const res = await fetch("/api/search-streams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, year, type, season, episode, imdbId }),
  });
  const data = await res.json();
  return data.results || [];
}

export async function playTorrent(infoHash, name, season, episode) {
  const res = await fetch("/api/play-torrent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ infoHash, name, season, episode }),
  });
  if (!res.ok) throw new Error("stream_failed");
  return res.json();
}

export async function checkAvailability(items) {
  const res = await fetch("/api/check-availability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const data = await res.json();
  return new Set(data.available || []);
}

export function fetchStatus(infoHash) {
  return get(`/api/status/${infoHash}`);
}

export function fetchDuration(infoHash, fileIndex) {
  return get(`/api/duration/${infoHash}/${fileIndex}`);
}

export function fetchSubtitleTracks(infoHash, fileIndex) {
  return get(`/api/subtitles/${infoHash}/${fileIndex}`);
}

export function fetchAudioTracks(infoHash, fileIndex) {
  return get(`/api/audio-tracks/${infoHash}/${fileIndex}`);
}
