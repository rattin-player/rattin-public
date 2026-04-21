// IntroDB client — crowdsourced intro/outro timestamps keyed by IMDb ID + season + episode.
// See https://introdb.app / OpenAPI at https://api.introdb.app/openapi.json

import type { LogFn } from "../types.js";

type FetcherFn = typeof globalThis.fetch;

let _fetcher: FetcherFn | null = null;

export function _setFetcher(fn: FetcherFn | null): void { _fetcher = fn; }
function getFetcher(): FetcherFn { return _fetcher || globalThis.fetch; }

const INTRODB_BASE = "https://api.introdb.app";
const SUBMISSION_FLOOR = 2;
const FETCH_TIMEOUT_MS = 5000;

const noopLog: LogFn = () => {};

export interface IntrodbSegment {
  startSec: number;
  endSec: number;
  confidence: number;
  submissionCount: number;
}

export interface IntrodbMarkers {
  intro: IntrodbSegment | null;
  outro: IntrodbSegment | null;
  imdbId: string;
}

interface ApiSegment {
  start_sec?: number;
  end_sec?: number;
  confidence?: number;
  submission_count?: number;
}
interface ApiResponse {
  imdb_id?: string;
  intro?: ApiSegment | null;
  outro?: ApiSegment | null;
  recap?: ApiSegment | null;
}

function normalizeSegment(s: ApiSegment | null | undefined): IntrodbSegment | null {
  if (!s) return null;
  const count = s.submission_count ?? 0;
  if (count < SUBMISSION_FLOOR) return null;
  if (typeof s.start_sec !== "number" || typeof s.end_sec !== "number") return null;
  return {
    startSec: s.start_sec,
    endSec: s.end_sec,
    confidence: s.confidence ?? 0,
    submissionCount: count,
  };
}

export async function lookupIntrodbMarkers(
  imdbId: string,
  season: number,
  episode: number,
  log: LogFn = noopLog,
): Promise<IntrodbMarkers | null> {
  const doFetch = getFetcher();
  const url = `${INTRODB_BASE}/segments?imdb_id=${encodeURIComponent(imdbId)}&season=${season}&episode=${episode}`;
  log("info", "[introdb] GET", { url });
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      log("info", "[introdb] non-ok response", { url, status: res.status });
      return null;
    }
    const data = await res.json() as ApiResponse;
    log("info", "[introdb] raw response", {
      imdb_id: data.imdb_id, intro: data.intro, outro: data.outro, recap: data.recap,
    });
    const intro = normalizeSegment(data.intro);
    const outro = normalizeSegment(data.outro);
    if (!intro && !outro) {
      log("info", "[introdb] both segments rejected by floor/shape", {
        introRaw: data.intro, outroRaw: data.outro, floor: SUBMISSION_FLOOR,
      });
      return null;
    }
    return { intro, outro, imdbId };
  } catch (err) {
    log("info", "[introdb] fetch threw", { url, error: (err as Error).message });
    return null;
  }
}
