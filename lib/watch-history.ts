import type { JsonStore } from "./store.js";

export interface WatchRecord {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  posterPath: string | null;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  position: number;   // seconds
  duration: number;   // seconds
  finished: boolean;
  updatedAt: string;  // ISO 8601
  dismissed?: boolean; // hidden from Continue Watching without deleting data
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

  /** Unfinished items with >= 5 min watched, sorted by most recent, limit 20. */
  getContinueWatching(): WatchRecord[] {
    return this.store
      .query((r) => !r.finished && !r.dismissed && r.position >= MIN_WATCH_SECONDS)
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

    // Find the first unfinished episode (by season/episode order)
    const unfinished = episodes.find((e) => !e.finished);
    if (unfinished) {
      return { season: unfinished.season ?? 1, episode: unfinished.episode ?? 1, position: unfinished.position };
    }

    // All recorded episodes are finished — suggest the next one after the last
    const last = episodes[episodes.length - 1];
    return {
      season: last.season ?? 1,
      episode: (last.episode ?? 0) + 1,
      position: 0,
    };
  }

  /** Dismiss a record from Continue Watching without deleting watch data. */
  dismiss(mediaType: string, tmdbId: number, season?: number, episode?: number): void {
    const key = recordKey(mediaType, tmdbId, season, episode);
    const record = this.store.get(key);
    if (record) this.store.set(key, { ...record, dismissed: true });
  }

  flush(): void { this.store.flush(); }
  shutdown(): void { this.store.shutdown(); }
}
