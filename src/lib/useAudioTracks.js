import { useState, useEffect, useCallback } from "react";
import { LANG_MAP } from "./useSubtitles";
import { fetchAudioTracks } from "./api";

export function useAudioTracks(videoRef, deps) {
  const {
    infoHash, fileIndex, audioTracksRef, activeAudioRef,
    preSelectedAudio, getEffectiveTime, isLiveRef,
    setLoading, setLoadingReason, pendingSubReload,
  } = deps;

  const [audioTracks, setAudioTracksRaw] = useState([]);
  const [activeAudio, setActiveAudioRaw] = useState(null);

  function setAudioTracks(val) {
    setAudioTracksRaw((prev) => {
      const next = typeof val === "function" ? val(prev) : val;
      audioTracksRef.current = next;
      return next;
    });
  }

  function setActiveAudio(val) {
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
            return data.tracks.map((t) => ({
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

  const switchAudio = useCallback((streamIndex) => {
    const idx = parseInt(streamIndex, 10);
    if (isNaN(idx)) return;
    if (activeAudioRef.current === idx) return;
    setActiveAudio(idx);
    const v = videoRef.current;
    if (!v) return;
    const pos = getEffectiveTime();
    setLoading(true);
    setLoadingReason("seeking");
    if (isLiveRef.current) {
      v.src = `/api/stream/${infoHash}/${fileIndex}?t=${pos}&audio=${idx}`;
    } else {
      v.src = `/api/stream/${infoHash}/${fileIndex}?audio=${idx}`;
      v.addEventListener("loadedmetadata", function onMeta() {
        v.removeEventListener("loadedmetadata", onMeta);
        v.currentTime = pos;
      }, { once: true });
    }
    v.play().catch(() => {});
    pendingSubReload.current = isLiveRef.current ? pos : 0;
  }, [infoHash, fileIndex]);

  return { audioTracks, activeAudio, switchAudio };
}
