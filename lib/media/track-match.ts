const LANG_ALIASES: Record<string, string> = {
  jpn: "ja", ja: "ja", japanese: "ja", "日本語": "ja", jp: "ja",
  eng: "en", en: "en", english: "en",
  kor: "ko", ko: "ko", korean: "ko", "한국어": "ko",
  zho: "zh", zh: "zh", chi: "zh", mandarin: "zh", "中文": "zh",
  spa: "es", es: "es", spanish: "es",
};

export function normalizeLang(raw: string | undefined | null): string {
  if (!raw) return "";
  const lower = raw.trim().toLowerCase();
  const bare = lower.split(/[-_]/)[0];
  return LANG_ALIASES[lower] ?? LANG_ALIASES[bare] ?? bare;
}

export interface AudioTrackInfo {
  index: number;
  lang: string;
  title?: string;
  codec?: string;
  channels?: number;
}

export interface SubtitleTrackInfo {
  index: number;
  lang: string;
  title?: string;
  forced?: boolean;
}

const COMMENTARY_RE = /\b(commentary|descriptive|director)\b/i;

export function pickAudioTrack(
  tracks: AudioTrackInfo[],
  persisted: { lang: string; title?: string } | null,
  defaultLang: string,
): number {
  const want = normalizeLang(persisted?.lang ?? defaultLang);
  if (!want) return -1;
  const sameLang = tracks.filter((t) => normalizeLang(t.lang) === want);
  if (sameLang.length === 0) return -1;
  if (persisted?.title) {
    const exact = sameLang.find((t) => t.title === persisted.title);
    if (exact) return exact.index;
  }
  const nonComm = sameLang.filter((t) => !COMMENTARY_RE.test(t.title ?? ""));
  const pool = nonComm.length > 0 ? nonComm : sameLang;
  const common = pool.filter((t) => t.channels === 2 || t.channels === 6);
  return (common[0] ?? pool[0]).index;
}

export function pickSubtitleTrack(
  tracks: SubtitleTrackInfo[],
  persisted: { lang: string; title?: string } | null,
  defaultLang: string,
): number {
  const want = normalizeLang(persisted?.lang ?? defaultLang);
  if (!want) return -1;
  const sameLang = tracks.filter((t) => normalizeLang(t.lang) === want);
  if (sameLang.length === 0) return -1;
  if (persisted?.title) {
    const exact = sameLang.find((t) => t.title === persisted.title);
    if (exact) return exact.index;
  }
  const full = sameLang.filter((t) => !t.forced);
  const pool = full.length > 0 ? full : sameLang;
  return pool[0].index;
}
