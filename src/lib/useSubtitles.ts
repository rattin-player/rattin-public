import { useState, useEffect, useCallback, type MutableRefObject } from "react";
import { fetchStatus, fetchSubtitleTracks } from "./api.js";

export const LANG_MAP: Record<string, string> = {
  eng: "English", en: "English", spa: "Spanish", es: "Spanish",
  fre: "French", fr: "French", ger: "German", de: "German",
  por: "Portuguese", pt: "Portuguese", ita: "Italian", it: "Italian",
  jpn: "Japanese", ja: "Japanese", kor: "Korean", ko: "Korean",
  chi: "Chinese", zh: "Chinese", ara: "Arabic", ar: "Arabic",
  rus: "Russian", ru: "Russian", dut: "Dutch", nl: "Dutch",
  pol: "Polish", pl: "Polish", tur: "Turkish", tr: "Turkish",
};

export interface SubtitleOption {
  value: string;
  label: string;
  streamIndex?: number;
  fileIndex?: number;
}

interface UseSubtitlesDeps {
  infoHash: string;
  fileIndex: string;
  subsRef: MutableRefObject<SubtitleOption[]>;
  activeSubRef: MutableRefObject<string>;
  preSelectedSub: string | null;
}

interface UseSubtitlesReturn {
  subs: SubtitleOption[];
  activeSub: string;
  setSubs: (val: SubtitleOption[] | ((prev: SubtitleOption[]) => SubtitleOption[])) => void;
  setActiveSub: (val: string) => void;
  switchSubtitle: (val: string) => void;
  reloadActiveSub: (seekOffset: number) => void;
  shiftVtt: (vttText: string, offsetSeconds: number) => string;
  LANG_MAP: Record<string, string>;
}

/** Extract episode identifiers (e.g. "S01E03", "E03", "03") from a path or filename.
 *  Checks the full path so directory names like "Subs/Show.S01E03/" are matched. */
export function extractEpisodeId(pathOrName: string): string | null {
  const str = pathOrName.replace(/\.[^.]+$/, "");
  // Match S01E03, s1e3, etc. — anywhere in the path
  const se = str.match(/[Ss]\d{1,2}[Ee](\d{1,3})/);
  if (se) return se[0].toUpperCase();
  // Match standalone E03, EP03 — only in the filename to avoid false positives from dirs
  const base = str.split(/[/\\]/).pop() || "";
  const ep = base.match(/[Ee][Pp]?(\d{1,3})/);
  if (ep) return `E${ep[1].padStart(2, "0")}`;
  // Match " - 03" or ".03." patterns common in anime (but not years like 2024)
  const dash = base.match(/(?:^|[\s._-])(\d{2,3})(?:[\s._-]|$)/);
  if (dash && parseInt(dash[1]) < 500) return `E${dash[1]}`;
  return null;
}

/** Check if a subtitle file likely belongs to the given video file.
 *  subPath is the full torrent path (e.g. "Pack/Subs/Show.S01E03/3_English.srt")
 *  videoPath is the full torrent path (e.g. "Pack/Show.S01E03.720p.mkv") */
export function subtitleMatchesVideo(subPath: string, videoPath: string): boolean {
  const subFile = subPath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "").toLowerCase() || "";
  const vidFile = videoPath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "").toLowerCase() || "";

  // Exact base name match (e.g. "movie.srt" for "movie.mkv")
  if (subFile === vidFile) return true;
  // Sub starts with video base (e.g. "movie.en.srt" for "movie.mkv")
  if (subFile.startsWith(vidFile)) return true;

  // Episode-based matching — check the full path (parent dirs often have episode IDs)
  const subEp = extractEpisodeId(subPath);
  const vidEp = extractEpisodeId(videoPath);
  if (subEp && vidEp && subEp === vidEp) return true;

  return false;
}

// Tags that indicate a subtitle track is NOT plain dialogue
const NON_DIALOGUE_TAGS = /\b(sdh|forced|sign|song|commentary|comment|cc|closed.?caption|hearing.?impair|hard.?of.?hearing|descriptive|karaoke|dubtitle)\b/i;

function isEnglish(lang: string): boolean {
  const l = lang.toLowerCase();
  return l === "eng" || l === "en" || l === "english";
}

/** From embedded tracks (with lang/title fields), pick the English dialogue sub. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickBestEnglishSub(tracks: any[]): any | null {
  const eng = tracks.filter((t) => isEnglish(t.lang || "") || isEnglish(t.title || ""));
  if (eng.length === 0) return null;
  if (eng.length === 1) return eng[0];
  // Prefer the one without SDH/forced/signs tags — that's plain dialogue
  const dialogue = eng.filter((t) => !NON_DIALOGUE_TAGS.test(t.title || ""));
  return dialogue[0] || eng[0];
}

/** From external subs (with label strings), pick the English dialogue sub. */
function pickBestEnglishLabel(subs: { value: string; label: string }[]): { value: string; label: string } | null {
  const eng = subs.filter((s) => s.label.toLowerCase().includes("english"));
  if (eng.length === 0) return null;
  if (eng.length === 1) return eng[0];
  const dialogue = eng.filter((s) => !NON_DIALOGUE_TAGS.test(s.label));
  return dialogue[0] || eng[0];
}

export function useSubtitles(deps: UseSubtitlesDeps): UseSubtitlesReturn {
  const { infoHash, fileIndex, subsRef, activeSubRef, preSelectedSub } = deps;

  const [subs, setSubsRaw] = useState<SubtitleOption[]>(subsRef.current || []);
  const [activeSub, setActiveSubRaw] = useState<string>(activeSubRef.current || "");

  function setSubs(val: SubtitleOption[] | ((prev: SubtitleOption[]) => SubtitleOption[])) {
    setSubsRaw((prev) => {
      const next = typeof val === "function" ? val(prev) : val;
      subsRef.current = next;
      return next;
    });
  }

  function setActiveSub(val: string) {
    setActiveSubRaw(val);
    activeSubRef.current = val;
  }

  function guessLabel(name: string): string {
    const base = name.replace(/\.[^.]+$/, "").toLowerCase();
    for (const [code, lang] of Object.entries(LANG_MAP)) {
      if (base.includes("." + code) || base.includes("_" + code) || base.includes("-" + code)) return lang;
    }
    return name.replace(/\.[^.]+$/, "").split(/[/\\]/).pop() || name;
  }

  // Shift VTT cue timestamps and remove cues before the offset
  function shiftVtt(vttText: string, offsetSeconds: number): string {
    if (!offsetSeconds || offsetSeconds <= 0) return vttText;

    // Parse timestamp — supports both HH:MM:SS.mmm and MM:SS.mmm
    function parseTs(ts: string): number {
      const full = ts.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
      if (full) return parseInt(full[1]) * 3600 + parseInt(full[2]) * 60 + parseInt(full[3]) + parseInt(full[4]) / 1000;
      const short = ts.match(/(\d{2}):(\d{2})\.(\d{3})/);
      if (short) return parseInt(short[1]) * 60 + parseInt(short[2]) + parseInt(short[3]) / 1000;
      return -1;
    }

    function fmtTs(t: number): string {
      const hh = Math.floor(t / 3600);
      const mm = Math.floor((t % 3600) / 60);
      const ss = Math.floor(t % 60);
      const ms = Math.round((t % 1) * 1000);
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
    }

    const lines = vttText.split("\n");
    const out: string[] = [];
    let skip = false;
    for (const line of lines) {
      const arrow = line.match(/^(\d{2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{2}:\d{2}(?::\d{2})?\.\d{3})/);
      if (arrow) {
        const start = parseTs(arrow[1]);
        const end = parseTs(arrow[2]);
        if (end <= offsetSeconds) {
          skip = true; // entire cue is before offset — drop it
          continue;
        }
        skip = false;
        out.push(`${fmtTs(Math.max(0, start - offsetSeconds))} --> ${fmtTs(end - offsetSeconds)}`);
      } else if (!skip) {
        out.push(line);
      } else if (line.trim() === "") {
        skip = false; // blank line ends a skipped cue block
      }
    }
    return out.join("\n");
  }

  const reloadActiveSub = useCallback(function reloadActiveSub(_seekOffset: number) {
    // In native mode, mpv manages subtitle loading — no browser-side reload needed
  }, []);

  function switchSubtitle(val: string) {
    setActiveSub(val);
  }

  // Load embedded subtitles
  useEffect(() => {
    loadSubs();
    const timer = setInterval(loadSubs, 5000);
    return () => clearInterval(timer);

    async function loadSubs() {
      try {
        const data = await fetchSubtitleTracks(infoHash, fileIndex);
        if (data.tracks?.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setSubs((prev: SubtitleOption[]) => {
            if (prev.length === data.tracks.length) return prev;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return data.tracks.map((t: any) => ({
              value: `embedded:${t.streamIndex}`,
              label: (t.title || LANG_MAP[t.lang] || t.lang || `Track ${t.streamIndex}`) + " (embedded)",
              streamIndex: t.streamIndex,
            }));
          });
          // Auto-select: pre-selected from nav state, or English if multiple tracks.
          // Check activeSubRef inside the timeout to avoid racing with external sub auto-select.
          if (preSelectedSub) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const match = data.tracks.find((t: any) => `embedded:${t.streamIndex}` === preSelectedSub);
            if (match) {
              setTimeout(() => { if (!activeSubRef.current) switchSubtitle(preSelectedSub); }, 500);
            }
          } else if (data.tracks.length > 1) {
            const pick = pickBestEnglishSub(data.tracks);
            if (pick) {
              setTimeout(() => { if (!activeSubRef.current) switchSubtitle(`embedded:${pick.streamIndex}`); }, 500);
            }
          }
          clearInterval(timer);
        }
      } catch {}
    }
  }, [infoHash, fileIndex]);

  // Clear stale subs when switching torrent/file
  useEffect(() => {
    setSubs([]);
    setActiveSub("");
  }, [infoHash, fileIndex]);

  // Load external subtitle files — only those matching the current video
  useEffect(() => {
    fetchStatus(infoHash).then((data: { files?: Array<{ index: number; path?: string; name?: string; isSubtitle?: boolean }> }) => {
      if (!data.files) return;
      const fi = parseInt(fileIndex, 10);
      const videoFile = data.files.find((f) => f.index === fi);
      const videoPath = videoFile?.path || videoFile?.name || "";
      const allSubs = data.files.filter((f) => f.isSubtitle);
      let matched = allSubs.filter((f) => subtitleMatchesVideo(f.path || f.name || "", videoPath));
      // If no match (e.g. single video with loose subs), fall back to all
      if (matched.length === 0 && allSubs.length > 0) matched = allSubs;
      if (matched.length > 0) {
        const external = matched.map((f) => ({
          value: `file:${f.index}`,
          label: guessLabel(f.name || "") + " (external)",
          fileIndex: f.index,
        }));
        setSubs((prev) => {
          const embedded = prev.filter((s) => s.value.startsWith("embedded:"));
          return [...external, ...embedded];
        });
        // Auto-select English external sub if nothing selected yet
        if (!preSelectedSub && external.length > 1) {
          const pick = pickBestEnglishLabel(external);
          if (pick) {
            setTimeout(() => { if (!activeSubRef.current) switchSubtitle(pick.value); }, 500);
          }
        }
      }
    }).catch(() => {});
  }, [infoHash, fileIndex]);

  return {
    subs, activeSub, setSubs, setActiveSub,
    switchSubtitle, reloadActiveSub,
    shiftVtt, LANG_MAP,
  };
}
