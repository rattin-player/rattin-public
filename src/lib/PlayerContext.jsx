import { createContext, useContext, useState, useRef, useCallback, useEffect } from "react";

const PlayerContext = createContext(null);

export function usePlayer() {
  return useContext(PlayerContext);
}

export function PlayerProvider({ children }) {
  const videoRef = useRef(null);
  const [active, setActive] = useState(null); // { infoHash, fileIndex, title, tags }
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Exposed so Player page can push its effective time/duration (accounts for seekOffset)
  const effectiveTimeRef = useRef(null); // { time, duration, ts } — set by Player page
  const subsRef = useRef([]); // persisted subtitle list
  const activeSubRef = useRef(""); // persisted active subtitle value

  // Sync video state
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    function sync() {
      // Use effective values from Player page if recently updated (within 2s)
      const eff = effectiveTimeRef.current;
      if (eff && Date.now() - eff.ts < 2000) {
        setCurrentTime(eff.time);
        setDuration(eff.duration);
      } else {
        setCurrentTime(v.currentTime || 0);
        if (v.duration && isFinite(v.duration)) setDuration(v.duration);
      }
      setPlaying(!v.paused);
    }
    v.addEventListener("timeupdate", sync);
    v.addEventListener("play", sync);
    v.addEventListener("pause", sync);
    // Also poll to catch mini player state
    const interval = setInterval(sync, 500);
    return () => {
      v.removeEventListener("timeupdate", sync);
      v.removeEventListener("play", sync);
      v.removeEventListener("pause", sync);
      clearInterval(interval);
    };
  }, []);

  const startStream = useCallback((infoHash, fileIndex, title, tags) => {
    const v = videoRef.current;
    // If same stream, don't restart — just ensure it's playing
    if (active?.infoHash === infoHash && active?.fileIndex === fileIndex) {
      return;
    }
    const posKey = `playback:${infoHash}:${fileIndex}`;
    const savedPos = parseFloat(sessionStorage.getItem(posKey)) || 0;
    fetch(`/api/set-active/${infoHash}`, { method: "POST" }).catch(() => {});
    v.src = `/api/stream/${infoHash}/${fileIndex}`;
    if (savedPos > 0) {
      v.addEventListener("loadedmetadata", function onMeta() {
        v.removeEventListener("loadedmetadata", onMeta);
        v.currentTime = savedPos;
        v.play().catch(() => {});
      });
    } else {
      v.play().catch(() => {});
    }
    effectiveTimeRef.current = null;
    subsRef.current = [];
    activeSubRef.current = "";
    setActive({ infoHash, fileIndex, title, tags });
  }, [active]);

  const stopStream = useCallback(() => {
    const v = videoRef.current;
    if (active) {
      const posKey = `playback:${active.infoHash}:${active.fileIndex}`;
      const t = effectiveTimeRef.current?.time || v.currentTime || 0;
      if (t > 0) sessionStorage.setItem(posKey, String(t));
    }
    v.pause();
    v.src = "";
    setActive(null);
    setPlaying(false);
    effectiveTimeRef.current = null;
  }, [active]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  // Save position periodically
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      const v = videoRef.current;
      if (v && active) {
        const t = effectiveTimeRef.current?.time || v.currentTime || 0;
        if (t > 0) sessionStorage.setItem(`playback:${active.infoHash}:${active.fileIndex}`, String(t));
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [active]);

  return (
    <PlayerContext.Provider value={{
      videoRef, active, playing, currentTime, duration,
      startStream, stopStream, togglePlay,
      effectiveTimeRef, subsRef, activeSubRef,
    }}>
      <video ref={videoRef} style={{ display: "none" }} />
      {children}
    </PlayerContext.Provider>
  );
}
