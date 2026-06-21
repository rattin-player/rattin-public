// Frontend-level stale-while-revalidate cache for home page data.
// Data is stored in localStorage and survives app restarts.
// On mount, components read from cache for instant render, then
// revalidate in the background. The server's 24h TTLCache is the
// secondary layer; this is the primary layer for instant display.

const PREFIX = "rattin:home:";
const TTL = 60 * 60 * 1000; // 1 hour — TMDB lists don't change more often

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getHomeCache<T = any>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw) as { data: T; ts: number };
    if (Date.now() - ts > TTL) return null;
    return data;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setHomeCache(key: string, data: any): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    // quota exceeded or unavailable — app still works, just slower
  }
}

export function clearHomeCache(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {}
}
