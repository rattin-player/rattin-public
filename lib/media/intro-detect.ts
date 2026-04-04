// lib/intro-detect.ts
// Intro detection pipeline: fingerprint-based cross-episode comparison + AniSkip fallback.

import { extractFingerprint as defaultExtractor, crossCorrelate } from "./fingerprint.js";
import type { FingerprintResult, IntroEntry } from "../types.js";

type ExtractorFn = (filePath: string, durationSec: number) => Promise<FingerprintResult | number[]>;
type FetcherFn = typeof globalThis.fetch;

let _extractor: ExtractorFn | null = null;
let _fetcher: FetcherFn | null = null;

// Test helpers — allow injecting mock extractor/fetcher
export function _setExtractor(fn: ExtractorFn | null): void { _extractor = fn; }
export function _setFetcher(fn: FetcherFn | null): void { _fetcher = fn; }

function getExtractor(): ExtractorFn { return _extractor || defaultExtractor; }
function getFetcher(): FetcherFn { return _fetcher || globalThis.fetch; }

interface DetectIntroResult {
  intro_start: number;
  intro_end: number;
  score: number;
}

/**
 * Detect intro by cross-correlating audio fingerprints from 2+ episode files.
 * Uses the FIRST episode's offsets for the returned timestamps.
 */
export async function detectIntro(filePaths: string[] | null): Promise<DetectIntroResult | null> {
  if (!filePaths || filePaths.length < 2) return null;

  const extract = getExtractor();

  // Extract fingerprints, skipping files that fail (corrupt/incomplete downloads)
  const results: Array<FingerprintResult | number[]> = [];
  for (const fp of filePaths) {
    if (results.length >= 2) break;
    try {
      results.push(await extract(fp, 300));
    } catch {
      // File is corrupt or unreadable — skip it, try next
    }
  }
  if (results.length < 2) return null;

  const [resultA, resultB] = results;

  // extractFingerprint returns { fingerprint, duration } in production, or plain array in tests
  const fpA = Array.isArray(resultA) ? resultA : resultA.fingerprint;
  const fpB = Array.isArray(resultB) ? resultB : resultB.fingerprint;
  const durA = Array.isArray(resultA) ? fpA.length : resultA.duration;
  const rate = durA > 0 ? fpA.length / durA : 1;

  const match = crossCorrelate(fpA, fpB, rate);
  if (!match) return null;

  return {
    intro_start: match.offsetA,
    intro_end: match.offsetA + match.duration,
    score: match.score,
  };
}

const JIKAN_BASE = "https://api.jikan.moe/v4";
const ANISKIP_BASE = "https://api.aniskip.com/v2";

// Cache MAL IDs by title to avoid repeated Jikan lookups during binge sessions
const malIdCache = new Map<string, number>();

interface ExternalIntroResult {
  intro_start: number;
  intro_end: number;
}

/**
 * Look up intro timestamps from AniSkip (via Jikan for MAL ID resolution).
 */
export async function lookupExternal(title: string, season: number, episode: number, durationSec: number): Promise<ExternalIntroResult | null> {
  const doFetch = getFetcher();
  try {
    // Step 1: Resolve MAL ID via Jikan (cached by title)
    const titleKey = title.toLowerCase().trim();
    let malId = malIdCache.get(titleKey);
    if (!malId) {
      const jikanUrl = `${JIKAN_BASE}/anime?q=${encodeURIComponent(title)}&limit=1`;
      const jikanRes = await doFetch(jikanUrl);
      if (!jikanRes.ok) return null;
      const jikanData = await jikanRes.json() as { data?: Array<{ mal_id?: number }> };
      malId = jikanData.data?.[0]?.mal_id;
      if (!malId) return null;
      malIdCache.set(titleKey, malId);
    }

    // Step 2: Query AniSkip
    const aniskipUrl = `${ANISKIP_BASE}/skip-times/${malId}/${episode}?types[]=op&episodeLength=${durationSec}`;
    const aniskipRes = await doFetch(aniskipUrl);
    if (!aniskipRes.ok) return null;
    const aniskipData = await aniskipRes.json() as {
      found?: boolean;
      results?: Array<{ skipType: string; interval: { startTime: number; endTime: number } }>;
    };
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
