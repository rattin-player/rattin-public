// lib/intro-detect.js
// Intro detection pipeline: fingerprint-based cross-episode comparison + AniSkip fallback.

import { extractFingerprint as defaultExtractor, crossCorrelate } from "./fingerprint.js";

let _extractor = null;
let _fetcher = null;

// Test helpers — allow injecting mock extractor/fetcher
export function _setExtractor(fn) { _extractor = fn; }
export function _setFetcher(fn) { _fetcher = fn; }

function getExtractor() { return _extractor || defaultExtractor; }
function getFetcher() { return _fetcher || globalThis.fetch; }

/**
 * Detect intro by cross-correlating audio fingerprints from 2+ episode files.
 * Uses the FIRST episode's offsets for the returned timestamps.
 * @param {string[]} filePaths - paths to episode files (need at least 2)
 * @returns {Promise<{ intro_start: number, intro_end: number, score: number } | null>}
 */
export async function detectIntro(filePaths) {
  if (!filePaths || filePaths.length < 2) return null;

  const extract = getExtractor();
  let fpA, fpB;
  try {
    [fpA, fpB] = await Promise.all([
      extract(filePaths[0], 300),
      extract(filePaths[1], 300),
    ]);
  } catch {
    return null;
  }

  const match = crossCorrelate(fpA, fpB);
  if (!match) return null;

  return {
    intro_start: match.offsetA,
    intro_end: match.offsetA + match.duration,
    score: match.score,
  };
}

const JIKAN_BASE = "https://api.jikan.moe/v4";
const ANISKIP_BASE = "https://api.aniskip.com/v2";

/**
 * Look up intro timestamps from AniSkip (via Jikan for MAL ID resolution).
 * @param {string} title - show title
 * @param {number} season - season number (unused by AniSkip but kept for interface consistency)
 * @param {number} episode - episode number
 * @param {number} durationSec - episode duration in seconds
 * @returns {Promise<{ intro_start: number, intro_end: number } | null>}
 */
export async function lookupExternal(title, season, episode, durationSec) {
  const doFetch = getFetcher();
  try {
    // Step 1: Resolve MAL ID via Jikan
    const jikanUrl = `${JIKAN_BASE}/anime?q=${encodeURIComponent(title)}&limit=1`;
    const jikanRes = await doFetch(jikanUrl);
    if (!jikanRes.ok) return null;
    const jikanData = await jikanRes.json();
    const malId = jikanData.data?.[0]?.mal_id;
    if (!malId) return null;

    // Step 2: Query AniSkip
    const aniskipUrl = `${ANISKIP_BASE}/skip-times/${malId}/${episode}?types[]=op&episodeLength=${durationSec}`;
    const aniskipRes = await doFetch(aniskipUrl);
    if (!aniskipRes.ok) return null;
    const aniskipData = await aniskipRes.json();
    if (!aniskipData.found || !aniskipData.results?.length) return null;

    const op = aniskipData.results.find((r) => r.skipType === "op");
    if (!op) return null;

    return {
      intro_start: op.interval.startTime,
      intro_end: op.interval.endTime,
    };
  } catch {
    return null;
  }
}
