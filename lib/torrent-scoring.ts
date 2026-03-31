import path from "path";
import { VIDEO_EXTENSIONS } from "./media-utils.js";
import type { TorrentResult } from "./types.js";

interface FileEntry {
  name: string;
  length: number;
}

interface FileMatch {
  file: FileEntry;
  index: number;
}

export function scoreTorrent(result: TorrentResult, title: string, year: number | undefined, type: string): number {
  let score = 0;
  const name = result.name.toLowerCase();
  const titleLower = title.toLowerCase();

  if (!name.includes(titleLower.split(" ")[0])) return -1;

  const titleWords = titleLower.split(/\s+/);
  const matchedWords = titleWords.filter((w) => name.includes(w)).length;
  score += (matchedWords / titleWords.length) * 50;

  if (year && name.includes(String(year))) score += 15;

  if (/1080p/.test(name)) score += 20;
  if (/2160p|4k/i.test(name)) score += 15;
  if (/720p/.test(name)) score += 10;
  if (/blu-?ray|bdrip|bdremux/i.test(name)) score += 15;
  if (/web-?dl|webrip/i.test(name)) score += 12;
  if (/remux/i.test(name)) score += 10;

  if (/\bcam\b|hdcam|telecine|\bts\b|hdts|telesync/i.test(name)) score -= 50;

  // Prefer MP4 (browser-native, no transcode needed)
  if (/\.mp4\b/i.test(name)) score += 15;
  if (/\bx264\b.*\.mp4|\.mp4\b.*\bx264\b/i.test(name)) score += 5;
  // Penalize MKV slightly (needs transcode)
  if (/\.mkv\b/i.test(name)) score -= 5;

  if (result.seeders === 0) return -1;
  score += Math.min(30, Math.log2(result.seeders + 1) * 3);

  return score;
}

export function parseTags(name: string): string[] {
  const tags: string[] = [];
  const n = name;
  // Resolution
  if (/2160p/i.test(n)) tags.push("4K");
  else if (/1080p/i.test(n)) tags.push("1080p");
  else if (/720p/i.test(n)) tags.push("720p");
  else if (/480p/i.test(n)) tags.push("480p");
  // Source
  if (/blu-?ray|bdremux/i.test(n)) tags.push("BluRay");
  else if (/web-?dl/i.test(n)) tags.push("WEB-DL");
  else if (/webrip/i.test(n)) tags.push("WEBRip");
  else if (/bdrip/i.test(n)) tags.push("BDRip");
  else if (/hdtv/i.test(n)) tags.push("HDTV");
  else if (/\bcam\b|hdcam/i.test(n)) tags.push("CAM");
  // Codec
  if (/\bx265\b|\bhevc\b/i.test(n)) tags.push("HEVC");
  else if (/\bx264\b|\bavc\b/i.test(n)) tags.push("x264");
  else if (/\bav1\b/i.test(n)) tags.push("AV1");
  // Audio
  if (/atmos/i.test(n)) tags.push("Atmos");
  else if (/\bdts\b/i.test(n)) tags.push("DTS");
  else if (/ddp?\s?5\.1|dd\+?\s?5\.1|eac3/i.test(n)) tags.push("5.1");
  // Container
  if (/\.mp4\b/i.test(n)) tags.push("MP4");
  else if (/\.mkv\b/i.test(n)) tags.push("MKV");
  // Extras
  if (/remux/i.test(n)) tags.push("Remux");
  if (/hdr10\+/i.test(n)) tags.push("HDR10+");
  else if (/hdr/i.test(n)) tags.push("HDR");
  return tags;
}

/**
 * Match episode patterns in a filename.
 * Returns true if the filename matches the given season/episode.
 */
export function matchEpisodePattern(filename: string, season: number, episode: number): boolean {
  const s = String(season).padStart(2, "0");
  const e = String(episode).padStart(2, "0");
  const sNum = String(season);
  const eNum = String(episode);
  const patterns = [
    new RegExp(`S${s}E${e}(?!\\d)`, "i"),           // S01E05
    new RegExp(`S${sNum}E${eNum}(?!\\d)`, "i"),      // S1E5
    new RegExp(`${sNum}x${e}(?!\\d)`, "i"),           // 1x05
    new RegExp(`${sNum}x${eNum}(?!\\d)`, "i"),        // 1x5
    new RegExp(`[._\\s/-]E${e}(?!\\d)`, "i"),         // .E05 _E05
    new RegExp(`[._\\s/-]E${eNum}(?!\\d)`, "i"),      // .E5
    new RegExp(`Episode[._\\s-]?${e}(?!\\d)`, "i"),   // Episode.05, Episode 05
    new RegExp(`Episode[._\\s-]?${eNum}(?!\\d)`, "i"),// Episode.5, Episode 5
    new RegExp(`Ep[._\\s-]?${e}(?!\\d)`, "i"),        // Ep05, Ep.05
  ];
  // Use just the filename, not the full path with folders
  const name = filename.split("/").pop() as string;
  return patterns.some((pat) => pat.test(name));
}

/**
 * Find the episode file in a list of files (plain objects with .name and .length).
 * Returns { file, index } or null.
 */
export function findEpisodeFile(files: FileEntry[] | null | undefined, season: number | undefined, episode: number | undefined): FileMatch | null {
  if (!files || !season || !episode) return findLargestVideoFile(files);
  let best: FileMatch | null = null;
  files.forEach((f, i) => {
    const ext = path.extname(f.name).toLowerCase();
    if (!VIDEO_EXTENSIONS.includes(ext)) return;
    if (matchEpisodePattern(f.name, season, episode)) {
      if (!best || f.length > best.file.length) best = { file: f, index: i };
    }
  });
  return best || findLargestVideoFile(files);
}

/**
 * Find the largest video file in a list of files.
 * Returns { file, index } or null.
 */
export function findLargestVideoFile(files: FileEntry[] | null | undefined): FileMatch | null {
  let best: FileMatch | null = null;
  if (!files) return null;
  files.forEach((f, i) => {
    const ext = path.extname(f.name).toLowerCase();
    if (VIDEO_EXTENSIONS.includes(ext)) {
      if (!best || f.length > best.file.length) best = { file: f, index: i };
    }
  });
  return best;
}

/**
 * Returns true if the torrent name contains a specific episode marker
 * for a DIFFERENT episode than what we want. Season packs, multi-season
 * packs, and complete series torrents (no episode marker) pass through.
 */
export function hasWrongEpisode(name: string, season: number, episode: number): boolean {
  const episodeMarkers = [...name.matchAll(/S(\d{1,2})E(\d{1,2})(?!\d)/gi)];
  if (episodeMarkers.length === 0) return false;

  for (const m of episodeMarkers) {
    const mSeason = parseInt(m[1], 10);
    const mEpisode = parseInt(m[2], 10);
    if (mSeason === season && mEpisode === episode) return false;
  }

  return true;
}

/**
 * Returns true if a torrent name looks like it contains the target season.
 * Matches multi-season ranges (S01-S31, S01-S15, Seasons 1-31) and
 * complete series indicators.
 */
export function coversTargetSeason(name: string, season: number): boolean {
  if (/complete|all.seasons/i.test(name)) return true;

  const rangePatterns = [
    /S(\d{1,2})\s*[-–.]\s*S(\d{1,2})/i,
    /Seasons?\s*(\d{1,2})\s*[-–]\s*(\d{1,2})/i,
  ];
  for (const pat of rangePatterns) {
    const m = name.match(pat);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = parseInt(m[2], 10);
      if (season >= start && season <= end) return true;
    }
  }

  return false;
}
