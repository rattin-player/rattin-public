import { fetchTMDB, tmdbCache, CACHE_TTL } from "../cache/cache.js";

type TmdbFetcherFn = (path: string) => Promise<unknown>;

let _fetcher: TmdbFetcherFn | null = null;

export function _setTmdbFetcher(fn: TmdbFetcherFn | null): void { _fetcher = fn; }
function getFetcher(): TmdbFetcherFn { return _fetcher || fetchTMDB; }

interface TmdbTvDetail {
  origin_country?: string[];
  genres?: Array<{ id: number; name: string }>;
}

const ANIMATION_GENRE_ID = 16;

export async function isAnime(tmdbId: string): Promise<boolean> {
  const cacheKey = `anime:${tmdbId}`;
  const cached = tmdbCache.get(cacheKey);
  if (typeof cached === "boolean") return cached;

  try {
    const data = await getFetcher()(`/tv/${tmdbId}`) as TmdbTvDetail;
    const jp = Array.isArray(data.origin_country) && data.origin_country.includes("JP");
    const animation = Array.isArray(data.genres) && data.genres.some((g) => g?.id === ANIMATION_GENRE_ID);
    const result = jp && animation;
    tmdbCache.set(cacheKey, result, CACHE_TTL.TV);
    return result;
  } catch {
    return false;
  }
}
