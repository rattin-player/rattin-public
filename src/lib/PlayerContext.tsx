import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode, type MutableRefObject } from "react";
import type { SubtitleOption } from "./useSubtitles";
import type { AudioTrackOption } from "./useAudioTracks";
import { mpvTogglePause, mpvSetVolume, mpvSetSubFontSize, mpvStopAndWait } from "./native-bridge";

interface ActiveStream {
  infoHash: string;
  fileIndex: string;
  title: string;
  tags: string[];
}

interface EffectiveTime {
  time: number;
  duration: number;
  ts: number;
}

interface IntroRange {
  start: number;
  end: number;
}

interface CommandHandlers {
  seek: (seconds: number) => void;
  seekRelative: (delta: number) => void;
  switchSubtitle: (val: string) => void;
  switchAudio: (streamIndex: string | number) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  switchSource?: (source: any) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NavigateFn = (...args: any[]) => void;

interface PlayerContextValue {
  active: ActiveStream | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  startStream: (infoHash: string | number, fileIndex: string | number, title: string, tags: string[], debridUrl?: string) => void;
  stopStream: () => void;
  togglePlay: () => void;
  effectiveTimeRef: MutableRefObject<EffectiveTime | null>;
  subsRef: MutableRefObject<SubtitleOption[]>;
  activeSubRef: MutableRefObject<string>;
  audioTracksRef: MutableRefObject<AudioTrackOption[]>;
  activeAudioRef: MutableRefObject<number | null>;
  dlProgressRef: MutableRefObject<number>;
  dlSpeedRef: MutableRefObject<number>;
  dlPeersRef: MutableRefObject<number>;
  commandRef: MutableRefObject<CommandHandlers | null>;
  navigateRef: MutableRefObject<NavigateFn | null>;
  rcSessionId: string | null;
  setRcSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  rcAuthToken: string | null;
  setRcAuthToken: React.Dispatch<React.SetStateAction<string | null>>;
  rcRemoteConnected: boolean;
  rcQrRequested: boolean;
  introRangeRef: MutableRefObject<IntroRange | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourcesRef: MutableRefObject<any[]>;
  subSize: number;
  adjustSubSize: (delta: number) => void;
  switching: boolean;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function usePlayer(): PlayerContextValue {
  return useContext(PlayerContext)!;
}

// Remote mode detection: URL has ?session=<id> or localStorage has rc-session
export function useRemoteMode(): { isRemote: boolean; sessionId: string | null } {
  const [state, setState] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session") || localStorage.getItem("rc-session") || null;
    return { isRemote: !!sessionId, sessionId };
  });

  // Ensure rc_token cookie stays alive from localStorage (survives page refresh)
  useEffect(() => {
    if (state.isRemote) {
      const token = localStorage.getItem("rc-token");
      if (token && !document.cookie.includes("rc_token=")) {
        document.cookie = `rc_token=${token}; path=/; max-age=${60 * 60 * 24}; SameSite=Lax`;
      }
    }
  }, [state.isRemote]);

  useEffect(() => {
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

interface PlayerProviderProps {
  children: ReactNode;
}

export function PlayerProvider({ children }: PlayerProviderProps) {
  const [active, setActive] = useState<ActiveStream | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const playingRef = useRef(false);
  playingRef.current = playing;
  const volumeRef = useRef(1);
  volumeRef.current = volume;
  const effectiveTimeRef = useRef<EffectiveTime | null>(null);
  const subsRef = useRef<SubtitleOption[]>([]);
  const activeSubRef = useRef("");
  const audioTracksRef = useRef<AudioTrackOption[]>([]);
  const activeAudioRef = useRef<number | null>(null);
  const commandRef = useRef<CommandHandlers | null>(null);
  const dlProgressRef = useRef(0);
  const dlSpeedRef = useRef(0);
  const dlPeersRef = useRef(0);
  const introRangeRef = useRef<IntroRange | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sourcesRef = useRef<any[]>([]);
  const [subSize, setSubSize] = useState(55);
  const subSizeRef = useRef(55);
  subSizeRef.current = subSize;
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  switchingRef.current = switching;

  // Remote control session (TV mode — not remote mode)
  // Persist in sessionStorage so PC page reload preserves the session
  const [rcSessionId, setRcSessionId] = useState<string | null>(() => sessionStorage.getItem("rc-sessionId") || null);
  const [rcAuthToken, setRcAuthToken] = useState<string | null>(() => sessionStorage.getItem("rc-authToken") || null);
  const [rcRemoteConnected, setRcRemoteConnected] = useState(false);
  const [rcQrRequested, setRcQrRequested] = useState(false);

  useEffect(() => {
    if (rcSessionId) sessionStorage.setItem("rc-sessionId", rcSessionId);
    else sessionStorage.removeItem("rc-sessionId");
  }, [rcSessionId]);

  useEffect(() => {
    if (rcAuthToken) sessionStorage.setItem("rc-authToken", rcAuthToken);
    else sessionStorage.removeItem("rc-authToken");
  }, [rcAuthToken]);
  const rcEventSourceRef = useRef<EventSource | null>(null);
  const stateReportTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastReportedState = useRef<string | null>(null);
  const reportStateRef = useRef<(() => void) | null>(null);
  const navigateRef = useRef<NavigateFn | null>(null);

  // Stable refs for SSE command handler (avoid reconnecting SSE when callbacks change)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const startStreamRef = useRef<((...args: any[]) => void) | null>(null);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const togglePlayRef = useRef<(() => void) | null>(null);

  // Sync React state from effectiveTimeRef (updated by mpv events in Player.tsx)
  useEffect(() => {
    const interval = setInterval(() => {
      const eff = effectiveTimeRef.current;
      if (eff && Date.now() - eff.ts < 2000) {
        setCurrentTime(eff.time);
        setDuration(eff.duration);
      }
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const startStream = useCallback((infoHash: string | number, fileIndex: string | number, title: string, tags: string[], _debridUrl?: string) => {
    if (active?.infoHash === String(infoHash) && String(active?.fileIndex) === String(fileIndex)) {
      return;
    }
    // Save position of the current stream before switching (mirrors stopStream behavior)
    if (active) {
      const posKey = `playback:${active.infoHash}:${active.fileIndex}`;
      const t = effectiveTimeRef.current?.time || 0;
      if (t > 0) sessionStorage.setItem(posKey, String(t));
    }
    const ih = String(infoHash);
    const fi = String(fileIndex);
    fetch(`/api/set-active/${ih}`, { method: "POST" }).catch(() => {});

    effectiveTimeRef.current = null;
    subsRef.current = [];
    activeSubRef.current = "";
    audioTracksRef.current = [];
    activeAudioRef.current = null;
    introRangeRef.current = null;
    setActive({ infoHash: ih, fileIndex: fi, title, tags });
  }, [active]);

  const stopStream = useCallback(() => {
    if (active) {
      const posKey = `playback:${active.infoHash}:${active.fileIndex}`;
      const t = effectiveTimeRef.current?.time || 0;
      if (t > 0) sessionStorage.setItem(posKey, String(t));
    }
    introRangeRef.current = null;
    setActive(null);
    setPlaying(false);
    effectiveTimeRef.current = null;
  }, [active]);

  const togglePlay = useCallback(() => {
    mpvTogglePause();
  }, []);

  const adjustSubSize = useCallback((delta: number) => {
    setSubSize((prev) => {
      const next = Math.max(20, Math.min(100, prev + delta));
      mpvSetSubFontSize(next);
      return next;
    });
  }, []);

  startStreamRef.current = startStream;
  stopStreamRef.current = stopStream;
  togglePlayRef.current = togglePlay;

  // Save position periodically
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      if (active) {
        const t = effectiveTimeRef.current?.time || 0;
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

    es.addEventListener("command", (e: MessageEvent) => {
      const { action, value } = JSON.parse(e.data);
      switch (action) {
        case "toggle-play":
          togglePlayRef.current?.();
          break;
        case "seek":
          if (commandRef.current?.seek) commandRef.current.seek(value);
          break;
        case "seek-relative":
          if (commandRef.current?.seekRelative) commandRef.current.seekRelative(value);
          break;
        case "volume":
          mpvSetVolume(value * 100);
          setVolume(value);
          break;
        case "subtitle":
          if (commandRef.current?.switchSubtitle) commandRef.current.switchSubtitle(value);
          break;
        case "audio":
          if (commandRef.current?.switchAudio) commandRef.current.switchAudio(value);
          break;
        case "sub-size":
          adjustSubSize(value);
          break;
        case "skip-intro": {
          const range = introRangeRef.current;
          if (range && commandRef.current?.seek) commandRef.current.seek(range.end);
          break;
        }
        case "start-stream":
          if (value) {
            const wasOnPlayer = window.location.pathname.startsWith("/play/");
            console.log("[rc] start-stream", { infoHash: value.infoHash, title: value.title, wasOnPlayer, debridUrl: !!value.debridUrl });

            const navState = {
              tags: value.tags, title: value.title, debridUrl: value.debridUrl,
              year: value.year, type: value.type, season: value.season, episode: value.episode, imdbId: value.imdbId,
            };

            if (wasOnPlayer) {
              // Kill old player: navigate away to unmount Player, wait for mpv
              // to fully stop (same lifecycle as pressing Stop), then spawn new player
              setSwitching(true);
              navigateRef.current?.("/", { replace: true });
              mpvStopAndWait().then(() => {
                startStreamRef.current?.(value.infoHash, value.fileIndex, value.title, value.tags, value.debridUrl);
                navigateRef.current?.(`/play/${value.infoHash}/${value.fileIndex}`, { state: navState });
                setSwitching(false);
              });
            } else {
              startStreamRef.current?.(value.infoHash, value.fileIndex, value.title, value.tags, value.debridUrl);
              navigateRef.current?.(`/play/${value.infoHash}/${value.fileIndex}`, { state: navState });
            }
          }
          break;
        case "switch-source":
          if (value && commandRef.current?.switchSource) {
            commandRef.current.switchSource(value);
          }
          break;
        case "stop-stream":
          stopStreamRef.current?.();
          if (navigateRef.current) navigateRef.current("/");
          break;
        case "toggle-fullscreen":
          try {
            if (document.fullscreenElement) document.exitFullscreen();
            else document.documentElement.requestFullscreen?.();
          } catch {}
          break;
      }
    });

    es.addEventListener("remote-connected", () => {
      setRcRemoteConnected(true);
      setRcQrRequested(false); // remote connected, hide QR
    });
    es.addEventListener("show-qr", () => {
      setRcQrRequested(true);
    });
    es.addEventListener("remote-disconnected", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      setRcRemoteConnected(data.count > 0);
    });

    es.onerror = () => {
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
      rcEventSourceRef.current = null;
      setRcRemoteConnected(false);
    };
  }, [rcSessionId]);

  // ── TV Mode: Report state to remotes ──
  useEffect(() => {
    if (!rcSessionId) return;

    // Track last known good time/duration so we never report 0/0 during seeks
    const lkg = { ct: 0, dur: 0 };

    function reportState() {
      const eff = effectiveTimeRef.current;
      let ct = eff && Date.now() - eff.ts < 2000 ? eff.time : 0;
      let dur = eff && Date.now() - eff.ts < 2000 ? eff.duration : 0;

      // Hold last known good values during transient 0/0 states (seeking, rebuffering)
      if (dur > 0) lkg.dur = dur;
      if (ct > 0) lkg.ct = ct;
      if (dur === 0 && lkg.dur > 0) dur = lkg.dur;
      if (ct === 0 && lkg.ct > 0 && dur > 0) ct = lkg.ct;

      const state = {
        sessionId: rcSessionId,
        playing: playingRef.current,
        currentTime: ct,
        duration: dur,
        title: active?.title || "",
        tags: active?.tags || [],
        infoHash: active?.infoHash ?? "",
        fileIndex: active?.fileIndex ?? "",
        subs: subsRef.current,
        activeSub: activeSubRef.current,
        audioTracks: audioTracksRef.current,
        activeAudio: activeAudioRef.current,
        volume: volumeRef.current,
        dlProgress: dlProgressRef.current,
        dlSpeed: dlSpeedRef.current,
        dlPeers: dlPeersRef.current,
        introActive: !!(introRangeRef.current && ct >= introRangeRef.current.start && ct < introRangeRef.current.end),
        introEnd: introRangeRef.current?.end ?? null,
        subSize: subSizeRef.current,
        sources: sourcesRef.current,
        switching: switchingRef.current,
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

    reportStateRef.current = reportState;

    // Report every 1s during playback
    stateReportTimer.current = setInterval(reportState, 1000);

    return () => {
      reportStateRef.current = null;
      if (stateReportTimer.current) clearInterval(stateReportTimer.current);
    };
  }, [rcSessionId, active]);

  // Report immediately when playing state changes
  useEffect(() => {
    if (rcSessionId) reportStateRef.current?.();
  }, [playing, rcSessionId]);

  return (
    <PlayerContext.Provider value={{
      active, playing, currentTime, duration, volume,
      startStream, stopStream, togglePlay,
      effectiveTimeRef, subsRef, activeSubRef, audioTracksRef, activeAudioRef, dlProgressRef, dlSpeedRef, dlPeersRef,
      commandRef, navigateRef,
      rcSessionId, setRcSessionId, rcAuthToken, setRcAuthToken, rcRemoteConnected, rcQrRequested,
      introRangeRef, sourcesRef,
      subSize, adjustSubSize, switching,
    }}>
      {children}
    </PlayerContext.Provider>
  );
}
