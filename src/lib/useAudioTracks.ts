import { useState, useEffect, useCallback, type MutableRefObject } from "react";
import { LANG_MAP } from "./useSubtitles";
import { fetchAudioTracks } from "./api";

export interface AudioTrackOption {
  value: number;
  label: string;
}

interface UseAudioTracksDeps {
  infoHash: string;
  fileIndex: string;
  audioTracksRef: MutableRefObject<AudioTrackOption[]>;
  activeAudioRef: MutableRefObject<number | null>;
  preSelectedAudio: number | null;
}

interface UseAudioTracksReturn {
  audioTracks: AudioTrackOption[];
  activeAudio: number | null;
  switchAudio: (streamIndex: string | number) => void;
}

export function useAudioTracks(deps: UseAudioTracksDeps): UseAudioTracksReturn {
  const {
    infoHash, fileIndex, audioTracksRef, activeAudioRef,
    preSelectedAudio,
  } = deps;

  const [audioTracks, setAudioTracksRaw] = useState<AudioTrackOption[]>([]);
  const [activeAudio, setActiveAudioRaw] = useState<number | null>(null);

  function setAudioTracks(val: AudioTrackOption[] | ((prev: AudioTrackOption[]) => AudioTrackOption[])) {
    setAudioTracksRaw((prev) => {
      const next = typeof val === "function" ? val(prev) : val;
      audioTracksRef.current = next;
      return next;
    });
  }

  function setActiveAudio(val: number | null) {
    setActiveAudioRaw(val);
    activeAudioRef.current = val;
  }

  // Audio track loading
  useEffect(() => {
    loadAudioTracks();
    const timer = setInterval(loadAudioTracks, 5000);
    return () => clearInterval(timer);

    async function loadAudioTracks() {
      try {
        const data = await fetchAudioTracks(infoHash, fileIndex);
        if (data.tracks?.length > 0) {
          setAudioTracks((prev) => {
            if (prev.length === data.tracks.length) return prev;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return data.tracks.map((t: any) => ({
              value: t.streamIndex,
              label: (t.title || LANG_MAP[(t.lang || "").split(/[-_]/)[0]] || t.lang || `Track ${t.streamIndex}`) + (t.channels > 2 ? " 5.1" : ""),
            }));
          });
          if (activeAudioRef.current === null) {
            // Prefer pre-selected, then English, then first track
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const englishTrack = data.tracks.length > 1 ? data.tracks.find((t: any) => {
              const base = (t.lang || "").toLowerCase().split(/[-_]/)[0];
              return base === "eng" || base === "en" || base === "english";
            }) : null;
            const initial = preSelectedAudio ?? englishTrack?.streamIndex ?? data.tracks[0]?.streamIndex ?? null;
            setActiveAudio(initial);
          }
          clearInterval(timer);
        }
      } catch {}
    }
  }, [infoHash, fileIndex]);

  const switchAudio = useCallback((streamIndex: string | number) => {
    const idx = parseInt(String(streamIndex), 10);
    if (isNaN(idx)) return;
    if (activeAudioRef.current === idx) return;
    setActiveAudio(idx);
  }, []);

  return { audioTracks, activeAudio, switchAudio };
}
