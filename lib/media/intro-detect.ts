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

// Cache Jikan resolutions by (title, season) to avoid repeated lookups during binge sessions.
// Note: MAL IDs are per-season (e.g. "Attack on Titan" S1 and S3 have different IDs), so a
// seasonless cache key would silently return the wrong show's skip-times for later seasons.
interface JikanResolution { malId: number; jikanTitle: string; jikanQuery: string; seasonSpecific: boolean }
const malIdCache = new Map<string, JikanResolution>();

interface ExternalIntroResult {
  intro_start: number;
  intro_end: number;
}

export interface AniskipResolution {
  malId: number;
  jikanTitle: string;
  jikanQuery: string;
  aniskipUrl: string;
  seasonSpecific: boolean;
}

export interface AniskipMarkers {
  opStart: number;
  opEnd: number;
  edStart: number;
  episodeLength: number;
  resolution: AniskipResolution;
}

async function jikanSearch(query: string, doFetch: FetcherFn): Promise<{ malId: number; jikanTitle: string } | null> {
  const url = `${JIKAN_BASE}/anime?q=${encodeURIComponent(query)}&limit=1`;
  const res = await doFetch(url);
  if (!res.ok) return null;
  const body = await res.json() as { data?: Array<{ mal_id?: number; title?: string }> };
  const first = body.data?.[0];
  if (!first?.mal_id) return null;
  return { malId: first.mal_id, jikanTitle: first.title ?? "" };
}

async function resolveMalId(title: string, season: number, doFetch: FetcherFn): Promise<JikanResolution | null> {
  const key = `${title.toLowerCase().trim()}|s${season}`;
  const cached = malIdCache.get(key);
  if (cached) return cached;

  // For S>1, try the seasoned query first — MAL IDs are per-season.
  if (season > 1) {
    const seasonedQuery = `${title} Season ${season}`;
    const seasoned = await jikanSearch(seasonedQuery, doFetch);
    if (seasoned) {
      const r: JikanResolution = { ...seasoned, jikanQuery: seasonedQuery, seasonSpecific: true };
      malIdCache.set(key, r);
      return r;
    }
  }

  const base = await jikanSearch(title, doFetch);
  if (!base) return null;
  const r: JikanResolution = { ...base, jikanQuery: title, seasonSpecific: false };
  malIdCache.set(key, r);
  return r;
}

/**
 * Look up intro timestamps from AniSkip (via Jikan for MAL ID resolution).
 */
export async function lookupExternal(title: string, season: number, episode: number, durationSec: number): Promise<ExternalIntroResult | null> {
  const doFetch = getFetcher();
  try {
    const resolved = await resolveMalId(title, season, doFetch);
    if (!resolved) return null;

    const aniskipUrl = `${ANISKIP_BASE}/skip-times/${resolved.malId}/${episode}?types[]=op&episodeLength=${durationSec}`;
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

/**
 * Look up both intro (OP) and outro (ED) markers from AniSkip.
 * Returns null if no MAL ID can be resolved or AniSkip returns no markers.
 * Caller is responsible for the ±30s duration-mismatch guard (see computeMarkers).
 */
export async function lookupAniskipMarkers(
  title: string,
  episode: number,
  durationSec: number,
  season: number = 1,
): Promise<AniskipMarkers | null> {
  const doFetch = getFetcher();
  try {
    const resolved = await resolveMalId(title, season, doFetch);
    if (!resolved) return null;

    const aniskipUrl = `${ANISKIP_BASE}/skip-times/${resolved.malId}/${episode}?types[]=op&types[]=ed&episodeLength=${durationSec}`;
    const aniRes = await doFetch(aniskipUrl);
    if (!aniRes.ok) return null;
    const data = await aniRes.json() as {
      found?: boolean;
      results?: Array<{ skipType: string; interval: { startTime: number; endTime: number }; episodeLength?: number }>;
    };
    if (!data.found || !data.results?.length) return null;

    const op = data.results.find((r) => r.skipType === "op");
    const ed = data.results.find((r) => r.skipType === "ed");
    if (!op && !ed) return null;

    const episodeLength = data.results.find((r) => typeof r.episodeLength === "number")?.episodeLength ?? durationSec;

    return {
      opStart: op?.interval.startTime ?? 0,
      opEnd: op?.interval.endTime ?? 0,
      edStart: ed?.interval.startTime ?? 0,
      episodeLength,
      resolution: {
        malId: resolved.malId,
        jikanTitle: resolved.jikanTitle,
        jikanQuery: resolved.jikanQuery,
        aniskipUrl,
        seasonSpecific: resolved.seasonSpecific,
      },
    };
  } catch {
    return null;
  }
}
