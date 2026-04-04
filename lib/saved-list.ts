import type { JsonStore } from "./store.js";

export interface SavedItem {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  posterPath: string | null;
  savedAt: string;  // ISO 8601
}

function savedKey(mediaType: string, tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

export class SavedList {
  constructor(private store: JsonStore<SavedItem>) {}

  /** Toggle saved state. Returns true if now saved, false if removed. */
  toggle(item: Omit<SavedItem, "savedAt">): boolean {
    const key = savedKey(item.mediaType, item.tmdbId);
    if (this.store.has(key)) {
      this.store.delete(key);
      return false;
    }
    this.store.set(key, { ...item, savedAt: new Date().toISOString() });
    return true;
  }

  isSaved(mediaType: string, tmdbId: number): boolean {
    return this.store.has(savedKey(mediaType, tmdbId));
  }

  /** All saved items, sorted by most recently saved. */
  getAll(): SavedItem[] {
    return this.store.values().sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  flush(): void { this.store.flush(); }
  shutdown(): void { this.store.shutdown(); }
}
