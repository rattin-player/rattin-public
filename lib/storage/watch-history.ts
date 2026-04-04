import type { JsonStore } from "./store.js";

export interface WatchRecord {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  posterPath: string | null;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  seasonEpisodeCount?: number; // total episodes in this season (from TMDB)
  position: number;   // seconds
  duration: number;   // seconds
  finished: boolean;
  updatedAt: string;  // ISO 8601
  dismissed?: boolean; // hidden from Continue Watching without deleting data
  imdbId?: string;    // for Torrentio search (best provider)
  year?: number;      // for movie search quality
}

export interface ResumePoint {
  season: number;
  episode: number;
  position: number;
}

const FINISHED_THRESHOLD = 0.9;  // 90% = finished
const MIN_WATCH_SECONDS = 300;   // 5 minutes to count as "meaningful"

function recordKey(mediaType: string, tmdbId: number, season?: number, episode?: number): string {
  if (mediaType === "tv" && season != null && episode != null) {
    return `tv:${tmdbId}:s${season}e${episode}`;
  }
  return `${mediaType}:${tmdbId}`;
}

export class WatchHistory {
  constructor(private store: JsonStore<WatchRecord>) {}

  recordProgress(record: WatchRecord): void {
    const key = recordKey(record.mediaType, record.tmdbId, record.season, record.episode);
    const existing = this.store.get(key);
    // If duration is unknown (0), preserve the existing duration if we have one
    const duration = record.duration > 0 ? record.duration : (existing?.duration ?? 0);
    const finished = duration > 0 && (record.position / duration) >= FINISHED_THRESHOLD;
    this.store.set(key, { ...record, duration, finished, dismissed: false, updatedAt: new Date().toISOString() });
  }

  getProgress(mediaType: string, tmdbId: number, season?: number, episode?: number): WatchRecord | undefined {
    return this.store.get(recordKey(mediaType, tmdbId, season, episode));
  }

  /** Unfinished items + "next up" for TV series, sorted by most recent, limit 20. */
  getContinueWatching(): WatchRecord[] {
    // In-progress episodes
    const inProgress = this.store
      .query((r) => !r.finished && !r.dismissed && r.position >= MIN_WATCH_SECONDS);

    // Find TV series where all episodes are finished — create "next up" entries
    const tvByShow = new Map<number, WatchRecord[]>();
    for (const r of this.store.values()) {
      if (r.mediaType === "tv") {
        const list = tvByShow.get(r.tmdbId) || [];
        list.push(r);
        tvByShow.set(r.tmdbId, list);
      }
    }

    // Series already represented in inProgress
    const inProgressShows = new Set(inProgress.filter((r) => r.mediaType === "tv").map((r) => r.tmdbId));

    const nextUp: WatchRecord[] = [];
    for (const [tmdbId, eps] of tvByShow) {
      if (inProgressShows.has(tmdbId)) continue;
      // All episodes for this show are finished — suggest next
      if (eps.every((e) => e.finished)) {
        const sorted = eps.sort((a, b) => {
          const sd = (a.season ?? 0) - (b.season ?? 0);
          return sd !== 0 ? sd : (a.episode ?? 0) - (b.episode ?? 0);
        });
        const last = sorted[sorted.length - 1];
        if (last.dismissed) continue;
        const lastEp = last.episode ?? 0;
        const isSeasonFinale = last.seasonEpisodeCount != null && lastEp >= last.seasonEpisodeCount;
        nextUp.push({
          ...last,
          season: isSeasonFinale ? (last.season ?? 1) + 1 : (last.season ?? 1),
          episode: isSeasonFinale ? 1 : lastEp + 1,
          position: 0,
          duration: 0,
          finished: false,
          dismissed: false,
        });
      }
    }

    return [...inProgress, ...nextUp]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 20);
  }

  /** All items with >= 5 min watched, sorted by most recent, limit 20. */
  getRecentlyWatched(): WatchRecord[] {
    // For TV, deduplicate to one entry per series (the most recent episode)
    const seen = new Map<string, WatchRecord>();
    const records = this.store
      .query((r) => r.position >= MIN_WATCH_SECONDS)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const result: WatchRecord[] = [];
    for (const r of records) {
      const dedupeKey = r.mediaType === "tv" ? `tv:${r.tmdbId}` : `movie:${r.tmdbId}`;
      if (!seen.has(dedupeKey)) {
        seen.set(dedupeKey, r);
        result.push(r);
      }
      if (result.length >= 20) break;
    }
    return result;
  }

  /** All episode records for a series, sorted by season then episode. */
  getSeriesProgress(tmdbId: number): WatchRecord[] {
    return this.store
      .query((r) => r.mediaType === "tv" && r.tmdbId === tmdbId)
      .sort((a, b) => {
        const sd = (a.season ?? 0) - (b.season ?? 0);
        return sd !== 0 ? sd : (a.episode ?? 0) - (b.episode ?? 0);
      });
  }

  /**
   * Get resume point for a title (Netflix-style):
   * - Movie: returns position if unfinished, null if finished or unwatched
   * - TV: last unfinished episode, or next episode after last finished
   */
  getResumePoint(tmdbId: number, mediaType: string): ResumePoint | null {
    if (mediaType === "movie") {
      const record = this.store.get(`movie:${tmdbId}`);
      if (!record || record.finished) return null;
      return { season: 0, episode: 0, position: record.position };
    }

    // TV: episodes sorted by season/episode number
    const episodes = this.getSeriesProgress(tmdbId);
    if (episodes.length === 0) return null;

    // Most recently watched unfinished episode (by updatedAt)
    const unfinished = [...episodes]
      .filter((e) => !e.finished)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (unfinished.length > 0) {
      const ep = unfinished[0];
      return { season: ep.season ?? 1, episode: ep.episode ?? 1, position: ep.position };
    }

    // All recorded episodes are finished — suggest the next one after the last in order
    const last = episodes[episodes.length - 1];
    const lastEp = last.episode ?? 0;
    const isSeasonFinale = last.seasonEpisodeCount != null && lastEp >= last.seasonEpisodeCount;
    return {
      season: isSeasonFinale ? (last.season ?? 1) + 1 : (last.season ?? 1),
      episode: isSeasonFinale ? 1 : lastEp + 1,
      position: 0,
    };
  }

  /** Dismiss a record from Continue Watching without deleting watch data. */
  dismiss(mediaType: string, tmdbId: number, season?: number, episode?: number): void {
    const key = recordKey(mediaType, tmdbId, season, episode);
    const record = this.store.get(key);
    if (record) this.store.set(key, { ...record, dismissed: true });
  }

  get size(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
  flush(): void { this.store.flush(); }
  shutdown(): void { this.store.shutdown(); }
}
