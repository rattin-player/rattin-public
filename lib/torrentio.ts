// lib/torrentio.ts

interface TorrentioTitleParsed {
  torrentName: string;
  seeders: number;
  sizeStr: string;
  sizeBytes: number;
  source: string;
}

export function parseTorrentioTitle(title: string): TorrentioTitleParsed {
  const lines = title.split("\n");
  const torrentName = lines[0] || "";
  const full = title;
  const seedersMatch = full.match(/👤\s*(\d+)/);
  const sizeMatch = full.match(/💾\s*([\d.]+\s*[KMGT]?i?B)/i);
  const sourceMatch = full.match(/⚙️\s*(.+)/);
  const seeders = seedersMatch ? parseInt(seedersMatch[1], 10) : 0;
  const sizeStr = sizeMatch ? sizeMatch[1].trim() : "";
  const source = sourceMatch ? sourceMatch[1].trim() : "torrentio";
  return { torrentName, seeders, sizeStr, sizeBytes: parseSizeStr(sizeStr), source };
}

export function parseSizeStr(sizeStr: string): number {
  if (!sizeStr) return 0;
  const match = sizeStr.match(/([\d.]+)\s*([KMGT]?i?B)/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase().replace("I", "");
  const multipliers: Record<string, number> = {
    B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4,
  };
  return Math.round(num * (multipliers[unit] || 1));
}

const TORRENTIO_BASE = "https://torrentio.strem.fun";
const TORRENTIO_TIMEOUT = 8000;

const BROWSER_NATIVE_EXT = new Set([".mp4", ".m4v", ".webm"]);

export interface TorrentioResult {
  name: string;
  infoHash: string;
  size: number;
  seeders: number;
  leechers: number;
  source: string;
  fileIdx?: number;
  seasonPack?: boolean;
  native?: boolean;
}

export async function searchTorrentio(
  imdbId: string,
  type: "movie" | "tv",
  season?: number,
  episode?: number,
): Promise<TorrentioResult[]> {
  const url =
    type === "tv" && season !== undefined && episode !== undefined
      ? `${TORRENTIO_BASE}/stream/series/${imdbId}:${season}:${episode}.json`
      : `${TORRENTIO_BASE}/stream/movie/${imdbId}.json`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "MagnetPlayer/2.0" },
      signal: AbortSignal.timeout(TORRENTIO_TIMEOUT),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as { streams?: TorrentioStream[] };
    if (!data.streams || data.streams.length === 0) return [];
    return data.streams
      .filter((s) => s.infoHash)
      .map((s) => {
        const parsed = parseTorrentioTitle(s.title || "");
        const filename = s.behaviorHints?.filename || "";
        const ext = filename.includes(".") ? ("." + filename.split(".").pop()!.toLowerCase()) : "";
        return {
          name: parsed.torrentName,
          infoHash: s.infoHash.toLowerCase(),
          size: parsed.sizeBytes,
          seeders: parsed.seeders,
          leechers: 0,
          source: parsed.source,
          fileIdx: s.fileIdx,
          seasonPack:
            s.fileIdx !== undefined &&
            !/S\d{1,2}E\d{1,2}/i.test(parsed.torrentName),
          native: BROWSER_NATIVE_EXT.has(ext),
        };
      });
  } catch {
    return [];
  }
}

interface TorrentioStream {
  name?: string;
  title?: string;
  infoHash: string;
  fileIdx?: number;
  behaviorHints?: {
    bingeGroup?: string;
    filename?: string;
  };
}
