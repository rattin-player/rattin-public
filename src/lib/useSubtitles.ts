import { useState, useEffect, useCallback, type RefObject, type MutableRefObject } from "react";
import { fetchStatus, fetchSubtitleTracks } from "./api";

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
  isLiveRef: MutableRefObject<boolean>;
  seekOffsetRef: MutableRefObject<number>;
}

interface UseSubtitlesReturn {
  subs: SubtitleOption[];
  activeSub: string;
  setSubs: (val: SubtitleOption[] | ((prev: SubtitleOption[]) => SubtitleOption[])) => void;
  setActiveSub: (val: string) => void;
  switchSubtitle: (val: string) => void;
  reloadActiveSub: (seekOffset: number) => void;
  clearAllTracks: () => void;
  shiftVtt: (vttText: string, offsetSeconds: number) => string;
  LANG_MAP: Record<string, string>;
}

export function useSubtitles(videoRef: RefObject<HTMLVideoElement | null>, deps: UseSubtitlesDeps): UseSubtitlesReturn {
  const { infoHash, fileIndex, subsRef, activeSubRef, preSelectedSub, isLiveRef, seekOffsetRef } = deps;

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

  function clearAllTracks() {
    const v = videoRef.current;
    if (!v) return;
    for (const t of v.textTracks) t.mode = "disabled";
    v.querySelectorAll("track").forEach((el) => el.remove());
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

  function loadSubtitleTrack(src: string, timeOffset: number) {
    const v = videoRef.current;
    if (!v) return;
    clearAllTracks();
    fetch(src)
      .then((r) => r.ok ? r.text() : null)
      .then((text) => {
        if (!text || !activeSubRef.current) return;
        // Shift cue timestamps to match v.currentTime base (which starts at ~0 after seeking)
        const shifted = shiftVtt(text, timeOffset || 0);
        const blob = new Blob([shifted], { type: "text/vtt" });
        const url = URL.createObjectURL(blob);
        clearAllTracks();
        const track = document.createElement("track");
        track.kind = "subtitles";
        track.src = url;
        track.label = "Subtitles";
        track.default = true;
        v.appendChild(track);
        track.addEventListener("load", () => {
          if (track.track) track.track.mode = "showing";
          URL.revokeObjectURL(url);
        });
        setTimeout(() => {
          if (track.track && track.track.mode !== "showing") track.track.mode = "showing";
        }, 500);
      })
      .catch(() => {});
  }

  const reloadActiveSub = useCallback(function reloadActiveSub(seekOffset: number) {
    const sub = activeSubRef.current;
    if (!sub) return;
    let src: string | undefined;
    if (sub.startsWith("file:")) {
      src = `/api/subtitle/${infoHash}/${parseInt(sub.split(":")[1], 10)}`;
    } else if (sub.startsWith("embedded:")) {
      src = `/api/subtitle-extract/${infoHash}/${fileIndex}/${parseInt(sub.split(":")[1], 10)}`;
    }
    if (src) loadSubtitleTrack(src, seekOffset || 0);
  }, [infoHash, fileIndex]);

  function switchSubtitle(val: string) {
    setActiveSub(val);
    if (!videoRef.current) return;
    if (!val) { clearAllTracks(); return; }
    reloadActiveSub(isLiveRef.current ? seekOffsetRef.current : 0);
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
          // Auto-select pre-selected subtitle from navigation state
          if (preSelectedSub && !activeSubRef.current) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const match = data.tracks.find((t: any) => `embedded:${t.streamIndex}` === preSelectedSub);
            if (match) {
              setTimeout(() => switchSubtitle(preSelectedSub), 500);
            }
          }
          clearInterval(timer);
        }
      } catch {}
    }
  }, [infoHash, fileIndex]);

  // Load external subtitle files
  useEffect(() => {
    fetchStatus(infoHash).then((data) => {
      if (!data.files) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const subFiles = data.files.filter((f: any) => f.isSubtitle);
      if (subFiles.length > 0) {
        setSubs((prev) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const external = subFiles.map((f: any) => ({
            value: `file:${f.index}`,
            label: guessLabel(f.name) + " (external)",
            fileIndex: f.index,
          }));
          const embedded = prev.filter((s) => s.value.startsWith("embedded:"));
          return [...external, ...embedded];
        });
      }
    }).catch(() => {});
  }, [infoHash]);

  // Restore active subtitle when returning from mini player
  useEffect(() => {
    if (activeSub && subs.length > 0) {
      switchSubtitle(activeSub);
    }
  }, [subs.length]);

  return {
    subs, activeSub, setSubs, setActiveSub,
    switchSubtitle, reloadActiveSub, clearAllTracks,
    shiftVtt, LANG_MAP,
  };
}
