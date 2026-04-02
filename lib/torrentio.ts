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

export interface TorrentioMeta {
  languages: string[];
  hasSubs: boolean;
  multiAudio: boolean;
  foreignOnly: boolean;
}

const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const ENGLISH_FLAGS = new Set(["🇬🇧", "🇺🇸", "🇦🇺", "🇨🇦"]);

// Map 3-letter and common 2-letter language codes to flag emojis
const LANG_CODE_TO_FLAG: Record<string, string> = {
  ENG: "🇬🇧", EN: "🇬🇧",
  ITA: "🇮🇹", IT: "🇮🇹",
  FRA: "🇫🇷", FR: "🇫🇷",
  SPA: "🇪🇸", ES: "🇪🇸",
  GER: "🇩🇪", DE: "🇩🇪",
  POR: "🇵🇹", PT: "🇵🇹",
  RUS: "🇷🇺", RU: "🇷🇺",
  JPN: "🇯🇵", JP: "🇯🇵", JA: "🇯🇵",
  KOR: "🇰🇷", KO: "🇰🇷",
  CHI: "🇨🇳", ZH: "🇨🇳",
  ARA: "🇸🇦", AR: "🇸🇦",
  HIN: "🇮🇳", HI: "🇮🇳",
  DUT: "🇳🇱", NL: "🇳🇱",
  POL: "🇵🇱", PL: "🇵🇱",
  TUR: "🇹🇷", TR: "🇹🇷",
  SWE: "🇸🇪", SV: "🇸🇪",
  NOR: "🇳🇴", NO: "🇳🇴",
  DAN: "🇩🇰", DA: "🇩🇰",
  FIN: "🇫🇮", FI: "🇫🇮",
  GRE: "🇬🇷", EL: "🇬🇷",
  HEB: "🇮🇱", HE: "🇮🇱",
  CZE: "🇨🇿", CS: "🇨🇿",
  ROM: "🇷🇴", RO: "🇷🇴",
  HUN: "🇭🇺", HU: "🇭🇺",
};
const LANG_CODE_RE = new RegExp(`\\b(${Object.keys(LANG_CODE_TO_FLAG).join("|")})\\b`, "gi");

export function parseTorrentioMeta(title: string): TorrentioMeta {
  const full = title;

  // Extract flag emojis
  const flags = [...new Set(full.match(FLAG_RE) || [])];

  // Extract text language codes and convert to flags
  const codeMatches = [...full.matchAll(LANG_CODE_RE)];
  for (const m of codeMatches) {
    const flag = LANG_CODE_TO_FLAG[m[1].toUpperCase()];
    if (flag && !flags.includes(flag)) flags.push(flag);
  }

  // Subtitle detection — expanded patterns
  const hasSubs = /multi\s*sub|multisub|\bsub[s]?\b/i.test(full)
    || /\bsrt\b/i.test(full)
    || /\bsubtitle/i.test(full);

  // Multi-audio detection
  const multiAudio = /multi\s*audio|dual\s*audio|\bDUAL\b|multi\s*\d+\s*lang/i.test(full);

  // Foreign-only: has flags but none are English-speaking
  const foreignOnly = flags.length > 0 && !flags.some((f) => ENGLISH_FLAGS.has(f));

  return { languages: flags, hasSubs, multiAudio, foreignOnly };
}

const TORRENTIO_BASE = "https://search-provider-4.example";
const TORRENTIO_TIMEOUT = 8000;

export interface TorrentioResult {
  name: string;
  infoHash: string;
  size: number;
  seeders: number;
  leechers: number;
  source: string;
  fileIdx?: number;
  seasonPack?: boolean;
  languages?: string[];
  hasSubs?: boolean;
  multiAudio?: boolean;
  foreignOnly?: boolean;
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
      headers: { "User-Agent": "Rattin/2.0" },
      signal: AbortSignal.timeout(TORRENTIO_TIMEOUT),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as { streams?: TorrentioStream[] };
    if (!data.streams || data.streams.length === 0) return [];
    return data.streams
      .filter((s) => s.infoHash)
      .map((s) => {
        const parsed = parseTorrentioTitle(s.title || "");
        const meta = parseTorrentioMeta(s.title || "");
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
          languages: meta.languages,
          hasSubs: meta.hasSubs,
          multiAudio: meta.multiAudio,
          foreignOnly: meta.foreignOnly,
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
