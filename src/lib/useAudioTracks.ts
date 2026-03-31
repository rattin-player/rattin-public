import { useState, useEffect, useCallback, type RefObject, type MutableRefObject } from "react";
import { LANG_MAP } from "./useSubtitles";
import { fetchAudioTracks } from "./api";
import { isNative } from "./native-bridge";

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
  getEffectiveTime: () => number;
  isLiveRef: MutableRefObject<boolean>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingReason: React.Dispatch<React.SetStateAction<string>>;
  pendingSubReload: MutableRefObject<number | null>;
  debridUrl?: string;
}

interface UseAudioTracksReturn {
  audioTracks: AudioTrackOption[];
  activeAudio: number | null;
  switchAudio: (streamIndex: string | number) => void;
}

export function useAudioTracks(videoRef: RefObject<HTMLVideoElement | null>, deps: UseAudioTracksDeps): UseAudioTracksReturn {
  const {
    infoHash, fileIndex, audioTracksRef, activeAudioRef,
    preSelectedAudio, getEffectiveTime, isLiveRef,
    setLoading, setLoadingReason, pendingSubReload,
    debridUrl,
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
              label: (t.title || LANG_MAP[t.lang] || t.lang || `Track ${t.streamIndex}`) + (t.channels > 2 ? " 5.1" : ""),
            }));
          });
          if (activeAudioRef.current === null) {
            const initial = preSelectedAudio ?? data.tracks[0]?.streamIndex ?? null;
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

    // Native mode: mpv handles audio switching via bridge, don't touch v.src
    if (isNative) return;

    const v = videoRef.current;
    if (!v) return;
    const pos = getEffectiveTime();
    setLoading(true);
    setLoadingReason("seeking");

    // Debrid mode: use debrid-stream proxy instead of /api/stream
    const base = debridUrl
      ? `/api/debrid-stream?url=${encodeURIComponent(debridUrl)}`
      : `/api/stream/${infoHash}/${fileIndex}`;
    const sep = debridUrl ? "&" : "?";

    if (isLiveRef.current) {
      v.src = `${base}${sep}t=${pos}&audio=${idx}`;
    } else {
      v.src = `${base}${sep}audio=${idx}`;
      v.addEventListener("loadedmetadata", function onMeta() {
        v.removeEventListener("loadedmetadata", onMeta);
        v.currentTime = pos;
      }, { once: true });
    }
    v.play().catch(() => {});
    pendingSubReload.current = isLiveRef.current ? pos : 0;
  }, [infoHash, fileIndex, debridUrl]);

  return { audioTracks, activeAudio, switchAudio };
}
