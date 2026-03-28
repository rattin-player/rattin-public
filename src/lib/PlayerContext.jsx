import { createContext, useContext, useState, useRef, useCallback, useEffect } from "react";

const PlayerContext = createContext(null);

export function usePlayer() {
  return useContext(PlayerContext);
}

// Remote mode detection: URL has ?session=<id> or localStorage has rc-session
export function useRemoteMode() {
  const [state, setState] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session") || localStorage.getItem("rc-session") || null;
    return { isRemote: !!sessionId, sessionId };
  });

  useEffect(() => {
    // Re-check on popstate (back/forward navigation)
    function check() {
      const params = new URLSearchParams(window.location.search);
      const sessionId = params.get("session") || localStorage.getItem("rc-session") || null;
      setState({ isRemote: !!sessionId, sessionId });
    }
    window.addEventListener("popstate", check);
    return () => window.removeEventListener("popstate", check);
  }, []);

  return state;
}

export function PlayerProvider({ children }) {
  const videoRef = useRef(null);
  const [active, setActive] = useState(null); // { infoHash, fileIndex, title, tags }
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const effectiveTimeRef = useRef(null);
  const subsRef = useRef([]);
  const activeSubRef = useRef("");
  const commandRef = useRef(null); // Player.jsx registers { seek, seekRelative, switchSubtitle }

  // Remote control session (TV mode — not remote mode)
  const [rcSessionId, setRcSessionId] = useState(null);
  const rcEventSourceRef = useRef(null);
  const stateReportTimer = useRef(null);
  const lastReportedState = useRef(null);

  // Sync video state
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    function sync() {
      const eff = effectiveTimeRef.current;
      if (eff && Date.now() - eff.ts < 2000) {
        setCurrentTime(eff.time);
        setDuration(eff.duration);
      } else {
        setCurrentTime(v.currentTime || 0);
        if (v.duration && isFinite(v.duration)) setDuration(v.duration);
      }
      setPlaying(!v.paused);
      setVolume(v.volume);
    }
    v.addEventListener("timeupdate", sync);
    v.addEventListener("play", sync);
    v.addEventListener("pause", sync);
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

  // ── TV Mode: Listen for remote commands via SSE ──
  useEffect(() => {
    if (!rcSessionId) return;

    const es = new EventSource(`/api/rc/events?session=${rcSessionId}&role=player`);
    rcEventSourceRef.current = es;

    es.addEventListener("command", (e) => {
      const { action, value } = JSON.parse(e.data);
      const v = videoRef.current;
      switch (action) {
        case "toggle-play":
          togglePlay();
          break;
        case "seek":
          if (commandRef.current?.seek) commandRef.current.seek(value);
          else if (v) v.currentTime = value;
          break;
        case "seek-relative":
          if (commandRef.current?.seekRelative) commandRef.current.seekRelative(value);
          else if (v) v.currentTime = Math.max(0, v.currentTime + value);
          break;
        case "volume":
          if (v) { v.volume = value; setVolume(value); }
          break;
        case "subtitle":
          if (commandRef.current?.switchSubtitle) commandRef.current.switchSubtitle(value);
          break;
        case "start-stream":
          if (value) {
            startStream(value.infoHash, value.fileIndex, value.title, value.tags);
            // Navigate to player route
            window.location.hash = ""; // Clear any hash
            window.history.pushState({}, "", `/play/${value.infoHash}/${value.fileIndex}`);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }
          break;
        case "stop-stream":
          stopStream();
          break;
      }
    });

    es.onerror = () => {
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
      rcEventSourceRef.current = null;
    };
  }, [rcSessionId, togglePlay, startStream, stopStream]);

  // ── TV Mode: Report state to remotes ──
  useEffect(() => {
    if (!rcSessionId) return;

    function reportState() {
      const v = videoRef.current;
      if (!v) return;
      const eff = effectiveTimeRef.current;
      const ct = eff && Date.now() - eff.ts < 2000 ? eff.time : v.currentTime || 0;
      const dur = eff && Date.now() - eff.ts < 2000 ? eff.duration : (v.duration && isFinite(v.duration) ? v.duration : 0);

      const state = {
        sessionId: rcSessionId,
        playing: !v.paused,
        currentTime: ct,
        duration: dur,
        title: active?.title || "",
        tags: active?.tags || [],
        infoHash: active?.infoHash || "",
        fileIndex: active?.fileIndex || "",
        subs: subsRef.current,
        activeSub: activeSubRef.current,
        volume: v.volume,
        connected: true,
      };

      // Throttle: skip if same as last report
      const key = JSON.stringify(state);
      if (key === lastReportedState.current) return;
      lastReportedState.current = key;

      fetch("/api/rc/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      }).catch(() => {});
    }

    // Report immediately on play/pause/seek events
    const v = videoRef.current;
    function onEvent() { reportState(); }
    if (v) {
      v.addEventListener("play", onEvent);
      v.addEventListener("pause", onEvent);
      v.addEventListener("seeked", onEvent);
    }

    // Report every 1s during playback
    stateReportTimer.current = setInterval(reportState, 1000);

    return () => {
      clearInterval(stateReportTimer.current);
      if (v) {
        v.removeEventListener("play", onEvent);
        v.removeEventListener("pause", onEvent);
        v.removeEventListener("seeked", onEvent);
      }
    };
  }, [rcSessionId, active]);

  return (
    <PlayerContext.Provider value={{
      videoRef, active, playing, currentTime, duration, volume,
      startStream, stopStream, togglePlay,
      effectiveTimeRef, subsRef, activeSubRef,
      commandRef,
      rcSessionId, setRcSessionId,
    }}>
      <video ref={videoRef} style={{ display: "none" }} />
      {children}
    </PlayerContext.Provider>
  );
}
