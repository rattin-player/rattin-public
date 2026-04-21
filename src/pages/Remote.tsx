import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useNavigate, useLocation } from "react-router-dom";
import { clearRemoteSession, getRemoteSessionId, notifyRemoteSessionChanged } from "../lib/remote-session";
import { formatTime, formatBytes } from "../lib/utils";
import { fetchSeason, fetchEpisodeGroups, fetchSeriesProgress, poster, setBingeMode } from "../lib/api";
import type { BingeCapabilities, BingeDiagnostics, BingeEvent } from "../../lib/types";
import { nextEpisodeFrom } from "../../lib/media/next-episode";
import "./Remote.css";

const symbolFor = (on: boolean) => (on ? "✓" : "✗");

const fmtSec = (s: number | null | undefined): string => {
  if (s == null || !Number.isFinite(s)) return "—";
  const total = Math.max(0, Math.round(s));
  const m = Math.floor(total / 60);
  const r = String(total % 60).padStart(2, "0");
  return `${m}:${r}`;
};

const fmtRelative = (atEpoch: number, now: number): string => {
  const dt = Math.max(0, Math.round((now - atEpoch) / 1000));
  if (dt < 60) return `${dt}s ago`;
  const m = Math.floor(dt / 60);
  const s = dt % 60;
  return `${m}m${s ? ` ${s}s` : ""} ago`;
};

// ── State machine constants ──
const S = {
  NO_SESSION: "NO_SESSION",
  CONNECTING: "CONNECTING",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  CONNECTED_IDLE: "CONNECTED_IDLE",
  CONNECTED_PLAYING: "CONNECTED_PLAYING",
  PLAYER_OFFLINE: "PLAYER_OFFLINE",
  RECONNECTING: "RECONNECTING",
  CONNECTION_LOST: "CONNECTION_LOST",
} as const;

async function probeSession(sessionId: string): Promise<string> {
  try {
    const res = await fetch(`/api/rc/session/${sessionId}`);
    if (res.status === 404 || res.status === 401) return "expired";
    const data = await res.json();
    return data.playerOnline ? "online" : "offline";
  } catch {
    return "unreachable";
  }
}

export default function Remote() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const sessionId = getRemoteSessionId();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingTitle = (location.state as any)?.pendingTitle || null;

  useEffect(() => {
    const legacySession = searchParams.get("session");
    const legacyToken = searchParams.get("token");
    if (!legacySession || !legacyToken) return;
    const params = new URLSearchParams({ session: legacySession, token: legacyToken });
    window.location.replace(`/api/rc/auth?${params.toString()}`);
  }, [searchParams]);

  // ── Core state ──
  const [remoteState, setRemoteState] = useState(sessionId ? S.CONNECTING : S.NO_SESSION);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [state, setState] = useState<any>(null); // playback state from PC
  const [connectAttempt, setConnectAttempt] = useState(0); // increment to retry SSE
  const esRef = useRef<EventSource | null>(null);
  const failCount = useRef(0);

  // ── Optimistic local state ──
  const [localVolume, setLocalVolume] = useState<number | null>(null);
  const localVolumeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [seekDragging, setSeekDragging] = useState(false);
  const [seekDragValue, setSeekDragValue] = useState(0);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ dragging: false, value: 0, duration: 0 });
  const [optimisticPlaying, setOptimisticPlaying] = useState<boolean | null>(null);
  const optimisticPlayingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [optimisticSeekTime, setOptimisticSeekTime] = useState<number | null>(null);
  const optimisticSeekTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Last known good values ──
  const lastGood = useRef({ currentTime: 0, duration: 0 });
  const hadPlayback = useRef(false);

  // ── Pending playback (navigated here after starting a stream) ──
  const [pending, setPending] = useState(!!pendingTitle);
  useEffect(() => {
    if (!pendingTitle) return;
    // Clear pending after 10s if no playback arrives
    const t = setTimeout(() => setPending(false), 10000);
    return () => clearTimeout(t);
  }, [pendingTitle]);

  // ── Connection flash feedback ──
  const [showConnectedFlash, setShowConnectedFlash] = useState(false);

  // ── Binge mode state (from SSE "binge" event) ──
  const [bingeMode, setBingeModeState] = useState<{ enabled: boolean; capabilities: BingeCapabilities | null; diagnostics: BingeDiagnostics | null }>({ enabled: false, capabilities: null, diagnostics: null });
  const [bingeFlash, setBingeFlash] = useState<string | null>(null);
  const [showBingeDebug, setShowBingeDebug] = useState(false);
  const [showBingeFeatures, setShowBingeFeatures] = useState(false);
  const bingeToastedRef = useRef(false);

  // Dev-mode flag hides binge diagnostics panel unless explicitly requested
  const devMode = (() => {
    if (typeof window === "undefined") return false;
    if (searchParams.get("dev") === "1") return true;
    try { return window.localStorage.getItem("rattin.remoteDev") === "1"; } catch { return false; }
  })();

  useEffect(() => {
    if (!bingeMode.enabled) { bingeToastedRef.current = false; setBingeFlash(null); return; }
    if (bingeToastedRef.current || !bingeMode.capabilities) return;
    bingeToastedRef.current = true;
    const c = bingeMode.capabilities;
    const active = [c.autoSkipIntro, c.autoSkipCredits, c.persistTracks, c.autoAdvance, c.prefetch].filter((x) => x.enabled).length;
    setBingeFlash(`Binge mode ON — ${active} feature${active === 1 ? "" : "s"} active`);
    const t = setTimeout(() => setBingeFlash(null), 3000);
    return () => clearTimeout(t);
  }, [bingeMode.enabled, bingeMode.capabilities]);

  // ── Pairing code & panels ──
  const [digits, setDigits] = useState(["", "", "", ""]);
  const digitRefs = useRef<(HTMLInputElement | null)[]>([null, null, null, null]);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeLoading, setCodeLoading] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [showEpisodes, setShowEpisodes] = useState(false);
  const [epBrowserSeason, setEpBrowserSeason] = useState(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [epBrowserEps, setEpBrowserEps] = useState<any[] | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [epProgress, setEpProgress] = useState<Map<string, any>>(new Map());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [epGroupCache, setEpGroupCache] = useState<any>(null);

  // Invalidate episode group cache when the show changes
  useEffect(() => { setEpGroupCache(null); }, [state?.tmdbId]);

  function handleDigitChange(index: number, value: string) {
    const digit = value.replace(/\D/g, "").slice(-1); // take last char (handles paste-over)
    setDigits((prev) => {
      const next = [...prev];
      next[index] = digit;
      return next;
    });
    setCodeError(null);
    if (digit && index < 3) {
      digitRefs.current[index + 1]?.focus();
    }
  }

  function handleDigitKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      digitRefs.current[index - 1]?.focus();
    }
  }

  function handleDigitPaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 4);
    if (!pasted) return;
    const next = ["", "", "", ""];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    setCodeError(null);
    const focusIdx = Math.min(pasted.length, 3);
    digitRefs.current[focusIdx]?.focus();
  }

  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = digits.join("");
    if (code.length < 4) return;
    setCodeError(null);
    setCodeLoading(true);
    try {
      const res = await fetch("/api/rc/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        notifyRemoteSessionChanged();
        window.location.assign("/remote");
      } else {
        setCodeError("Invalid code. Check the code on your PC.");
      }
    } catch {
      setCodeError("Could not connect. Same network?");
    }
    setCodeLoading(false);
  }

  // ── SSE connection with probe-based expiry detection ──
  useEffect(() => {
    if (!sessionId) { setRemoteState(S.NO_SESSION); return; }
    let closed = false;
    failCount.current = 0;
    hadPlayback.current = false;

    async function connect() {
      if (closed) return;

      // Probe session first to detect expiry before opening SSE
      const probe = await probeSession(sessionId!);
      if (closed) return;
      if (probe === "expired") { setRemoteState(S.SESSION_EXPIRED); return; }

      const es = new EventSource(`/api/rc/events?session=${sessionId}&role=remote`);
      esRef.current = es;

      es.addEventListener("state", (e: MessageEvent) => {
        const parsed = JSON.parse(e.data);
        failCount.current = 0;
        if (parsed.duration > 0) lastGood.current.duration = parsed.duration;
        if (parsed.currentTime > 0 || (parsed.duration > 0 && parsed.currentTime === 0)) {
          lastGood.current.currentTime = parsed.currentTime;
        }
        // Clear optimistic overrides when server catches up
        if (optimisticSeekTimeout.current && parsed.currentTime > 0) {
          clearTimeout(optimisticSeekTimeout.current);
          optimisticSeekTimeout.current = null;
          setOptimisticSeekTime(null);
        }
        setState(parsed);
        if (parsed.infoHash) {
          setPending(false);
          hadPlayback.current = true;
        }
        setRemoteState(parsed.infoHash ? S.CONNECTED_PLAYING : S.CONNECTED_IDLE);
      });

      es.addEventListener("binge", (e: MessageEvent) => {
        try { setBingeModeState(JSON.parse(e.data)); } catch { /* ignore malformed */ }
      });

      es.addEventListener("connected", () => {
        failCount.current = 0;
        // Flash "Connected" feedback
        setShowConnectedFlash(true);
        setTimeout(() => setShowConnectedFlash(false), 2000);
        // We know player is online, but we wait for state event to determine idle vs playing
        setRemoteState((prev) =>
          prev === S.CONNECTED_PLAYING ? S.CONNECTED_PLAYING : S.CONNECTED_IDLE
        );
      });

      es.addEventListener("disconnected", () => {
        setRemoteState(S.PLAYER_OFFLINE);
      });

      es.onerror = async () => {
        failCount.current++;
        if (failCount.current > 10) {
          es.close();
          // Final probe to distinguish expired vs network
          const finalProbe = await probeSession(sessionId!);
          if (finalProbe === "expired") setRemoteState(S.SESSION_EXPIRED);
          else setRemoteState(S.CONNECTION_LOST);
        } else if (failCount.current > 2) {
          // Probe to check if session expired during reconnection
          const midProbe = await probeSession(sessionId!);
          if (midProbe === "expired") {
            es.close();
            setRemoteState(S.SESSION_EXPIRED);
          } else {
            setRemoteState(S.RECONNECTING);
          }
        }
      };
    }

    connect();
    return () => {
      closed = true;
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    };
  }, [sessionId, connectAttempt]);

  // Auto-navigate to home when playback stops (skip the "Browse Content" intermediate)
  // Don't navigate during switching — the idle state is transient
  useEffect(() => {
    if (remoteState === S.CONNECTED_IDLE && hadPlayback.current && !state?.switching) {
      navigate("/", { replace: true });
    }
  }, [remoteState, sessionId, navigate, state?.switching]);

  // ── Send command ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sendCommand = useCallback((action: string, value?: any) => {
    if (!sessionId) return;
    fetch("/api/rc/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, action, value }),
    }).catch(() => {});
  }, [sessionId]);

  // ── Episode browser ──
  function loadSeasonEpisodes(tmdbId: number | string, season: number, groups?: any) {
    const cached = groups ?? epGroupCache;
    if (cached?.found) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const group = cached.seasons?.find((s: any) => s.season_number === season);
      setEpBrowserEps(group?.episodes || []);
      return;
    }
    fetchSeason(tmdbId, season).then((d) => setEpBrowserEps(d.episodes || [])).catch(() => setEpBrowserEps([]));
  }

  function openEpisodeBrowser() {
    if (!state?.tmdbId || state.mediaType !== "tv") return;
    const season = state.season || 1;
    setEpBrowserSeason(season);
    setShowEpisodes(true);
    setEpBrowserEps(null);
    // Fetch episode groups first, then load episodes
    if (epGroupCache) {
      loadSeasonEpisodes(state.tmdbId, season);
    } else {
      fetchEpisodeGroups(state.tmdbId).then((g) => {
        setEpGroupCache(g);
        loadSeasonEpisodes(state.tmdbId, season, g);
      }).catch(() => loadSeasonEpisodes(state.tmdbId, season));
    }
    fetchSeriesProgress(Number(state.tmdbId)).then((r) => {
      const map = new Map();
      for (const ep of r.episodes) map.set(`s${ep.season}e${ep.episode}`, ep);
      setEpProgress(map);
    }).catch(() => {});
  }

  function switchEpBrowserSeason(s: number) {
    if (!state?.tmdbId) return;
    setEpBrowserSeason(s);
    setEpBrowserEps(null);
    loadSeasonEpisodes(state.tmdbId, s);
  }

  function playEpisode(season: number, episode: number) {
    setShowEpisodes(false);
    sendCommand("next-episode", { season, episode });
  }

  const codeComplete = digits.every((d) => d !== "");
  const pairingCodeForm = (
    <div className="remote-pair-code">
      <form onSubmit={handleCodeSubmit}>
        <div className="remote-pair-digits" onPaste={handleDigitPaste}>
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => { digitRefs.current[i] = el; }}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={1}
              value={d}
              onChange={(e) => handleDigitChange(i, e.target.value)}
              onKeyDown={(e) => handleDigitKeyDown(i, e)}
              className="remote-pair-digit"
              autoFocus={i === 0}
            />
          ))}
        </div>
        <button className="remote-action-btn" type="submit" disabled={!codeComplete || codeLoading}>
          {codeLoading ? "Connecting..." : "Connect"}
        </button>
      </form>
      {codeError && <p className="remote-pair-code-error">{codeError}</p>}
    </div>
  );

  // ── Actions ──
  function retry() {
    failCount.current = 0;
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setRemoteState(S.CONNECTING);
    setConnectAttempt((c) => c + 1);
  }

  function clearSession() {
    clearRemoteSession();
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setRemoteState(S.NO_SESSION);
    setState(null);
  }

  function handleTogglePlay() {
    const newPlaying = !(state?.playing);
    setOptimisticPlaying(newPlaying);
    if (optimisticPlayingTimeout.current) clearTimeout(optimisticPlayingTimeout.current);
    optimisticPlayingTimeout.current = setTimeout(() => setOptimisticPlaying(null), 3000);
    sendCommand("toggle-play");
  }

  function handleVolumeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const vol = parseFloat(e.target.value);
    setLocalVolume(vol);
    sendCommand("volume", vol);
    if (localVolumeTimeout.current) clearTimeout(localVolumeTimeout.current);
    localVolumeTimeout.current = setTimeout(() => setLocalVolume(null), 2000);
  }

  function handleSkip(delta: number) {
    const ct = getDisplayTime();
    const dur = getDisplayDuration();
    const target = Math.max(0, Math.min(dur, ct + delta));
    setOptimisticSeekTime(target);
    if (optimisticSeekTimeout.current) clearTimeout(optimisticSeekTimeout.current);
    optimisticSeekTimeout.current = setTimeout(() => setOptimisticSeekTime(null), 5000);
    sendCommand("seek-relative", delta);
  }

  // ── Seek bar ──
  function getSeekRatio(e: React.MouseEvent | React.TouchEvent) {
    if (!seekBarRef.current) return 0;
    const rect = seekBarRef.current.getBoundingClientRect();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function onSeekStart(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    dragRef.current.dragging = true;
    dragRef.current.duration = getDisplayDuration();
    setSeekDragging(true);
    const ratio = getSeekRatio(e);
    const val = ratio * dragRef.current.duration;
    dragRef.current.value = val;
    setSeekDragValue(val);
  }

  useEffect(() => {
    if (!seekDragging) return;
    function move(e: MouseEvent | TouchEvent) {
      if (!dragRef.current.dragging) return;
      const rect = seekBarRef.current?.getBoundingClientRect();
      if (!rect) return;
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const val = ratio * dragRef.current.duration;
      dragRef.current.value = val;
      setSeekDragValue(val);
    }
    function end() {
      if (!dragRef.current.dragging) return;
      dragRef.current.dragging = false;
      setSeekDragging(false);
      const seekTime = dragRef.current.value;
      setOptimisticSeekTime(seekTime);
      if (optimisticSeekTimeout.current) clearTimeout(optimisticSeekTimeout.current);
      optimisticSeekTimeout.current = setTimeout(() => setOptimisticSeekTime(null), 5000);
      sendCommand("seek", seekTime);
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", end);
    document.addEventListener("touchmove", move, { passive: true });
    document.addEventListener("touchend", end);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", end);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
    };
  }, [seekDragging, sendCommand]);

  // ── Display helpers ──
  function getDisplayTime(): number {
    if (seekDragging) return seekDragValue;
    if (optimisticSeekTime !== null) return optimisticSeekTime;
    const st = state?.currentTime || 0;
    return st > 0 ? st : lastGood.current.currentTime;
  }

  function getDisplayDuration(): number {
    const sd = state?.duration || 0;
    return sd > 0 ? sd : lastGood.current.duration;
  }

  function getDisplayPlaying(): boolean {
    if (optimisticPlaying !== null) return optimisticPlaying;
    return state?.playing ?? false;
  }

  function getDisplayVolume(): number {
    if (localVolume !== null) return localVolume;
    return state?.volume ?? 1;
  }

  // ── Render by state ──

  // NO_SESSION
  if (remoteState === S.NO_SESSION) {
    return (
      <div className="remote-page">
        <div className="remote-center-state">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="var(--text-muted)">
            <path d="M17 1H7c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2zm0 18H7V5h10v14z" />
          </svg>
          <h3>No Session</h3>
          <p>Open the pairing screen on your PC and enter the code below.</p>
          {pairingCodeForm}
        </div>
      </div>
    );
  }

  // CONNECTING
  if (remoteState === S.CONNECTING) {
    return (
      <div className="remote-page">
        <div className="remote-center-state">
          <div className="remote-spinner" />
          <p>Connecting to player...</p>
        </div>
      </div>
    );
  }

  // SESSION_EXPIRED
  if (remoteState === S.SESSION_EXPIRED) {
    return (
      <div className="remote-page">
        <div className="remote-center-state">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="var(--yellow)">
            <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
          </svg>
          <h3>Session Expired</h3>
          <p>Open the pairing screen on your PC and enter the new code.</p>
          {pairingCodeForm}
          <div className="remote-state-actions">
            <button className="remote-clear-link" onClick={retry}>Retry</button>
            <button className="remote-clear-link" onClick={clearSession}>Clear Session</button>
          </div>
        </div>
      </div>
    );
  }

  // CONNECTION_LOST
  if (remoteState === S.CONNECTION_LOST) {
    return (
      <div className="remote-page">
        <div className="remote-center-state">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="var(--red)">
            <path d="M24 8.98C20.93 5.9 16.69 4 12 4S3.07 5.9 0 8.98l2.83 2.83C5.24 9.4 8.42 8 12 8s6.76 1.4 9.17 3.81L24 8.98z" opacity="0.3"/>
            <path d="M2 16l2.83 2.83L12 11.66l7.17 7.17L22 16 12 6 2 16zm10-1.5l4.24 4.24L12 22.98l-4.24-4.24L12 14.5z"/>
          </svg>
          <h3>Connection Lost</h3>
          <p>Could not reconnect. Open the pairing screen on your PC and enter the new code.</p>
          {pairingCodeForm}
          <div className="remote-state-actions">
            <button className="remote-clear-link" onClick={retry}>Retry Connection</button>
            <button className="remote-clear-link" onClick={clearSession}>Clear Session</button>
          </div>
        </div>
      </div>
    );
  }

  // PLAYER_OFFLINE
  if (remoteState === S.PLAYER_OFFLINE) {
    return (
      <div className="remote-page">
        <div className="remote-center-state">
          <div className="remote-pulse-icon">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="var(--yellow)">
              <path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/>
            </svg>
          </div>
          <h3>Player Offline</h3>
          <p>Waiting for the player to come back online...</p>
          <button className="remote-clear-link" onClick={clearSession}>Forget Session</button>
        </div>
      </div>
    );
  }

  // ── CONNECTED states (IDLE, PLAYING, RECONNECTING) ──
  const isReconnecting = remoteState === S.RECONNECTING;
  const isSwitching = !!state?.switching;
  const isDisabled = isReconnecting || isSwitching;
  const hasPlayback = state?.infoHash;

  // CONNECTED_IDLE (no playback) — or pending playback
  if ((remoteState === S.CONNECTED_IDLE || (!hasPlayback && !isReconnecting)) && !pending) {
    return (
      <div className="remote-page">
        {showConnectedFlash && <div className="remote-flash">Connected</div>}
        <div className="remote-center-state">
          <div className="remote-status online">
            <span className="remote-status-dot" />
            Connected
          </div>
          <p>No active playback. Browse content to start playing.</p>
          <button className="remote-action-btn" onClick={() => navigate("/")}>
            Browse Content
          </button>
        </div>
      </div>
    );
  }

  // PENDING PLAYBACK (just started a stream, waiting for state)
  if (pending && !hasPlayback) {
    return (
      <div className="remote-page">
        {showConnectedFlash && <div className="remote-flash">Connected</div>}
        <div className="remote-center-state">
          <div className="remote-status online">
            <span className="remote-status-dot" />
            Connected
          </div>
          <div className="remote-spinner" />
          <p>Starting {pendingTitle || "playback"}...</p>
        </div>
      </div>
    );
  }

  // CONNECTED_PLAYING (+ RECONNECTING overlay)
  const ct = getDisplayTime();
  const dur = getDisplayDuration();
  const progress = dur > 0 ? (ct / dur) * 100 : 0;
  const dlPct = (state?.dlProgress ?? 1) * 100;
  const isPlaying = getDisplayPlaying();
  const displayVolume = getDisplayVolume();

  return (
    <div className={`remote-page ${isReconnecting ? "remote-dimmed" : ""}`}>
      {state?.posterPath && (
        <div
          className="remote-backdrop"
          style={{ backgroundImage: `url(${poster(state.posterPath, "w780")})` }}
        />
      )}
      {showConnectedFlash && <div className="remote-flash">Connected</div>}
      {isReconnecting && (
        <div className="remote-reconnecting-overlay">
          <div className="remote-spinner" />
          <span>Reconnecting...</span>
        </div>
      )}
      {isSwitching && !isReconnecting && (
        <div className="remote-reconnecting-overlay">
          <div className="remote-spinner" />
          <span>Switching...</span>
        </div>
      )}

      <div className="remote-top-bar">
        <button className="remote-back-btn" onClick={() => navigate(-1)} disabled={isDisabled}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
          </svg>
        </button>
        <div className={`remote-status ${isReconnecting ? "reconnecting" : "online"}`}>
          <span className="remote-status-dot" />
          {isReconnecting ? "Reconnecting..." : "Connected"}
        </div>
      </div>

      <div className="remote-title-area">
        <h2 className="remote-title">{state?.title || "Playing"}</h2>
        {state?.tags?.length > 0 && (
          <div className="remote-tags">
            {state.tags.map((t: string) => <span key={t} className="remote-tag">{t}</span>)}
          </div>
        )}
      </div>

      <div className="remote-play-area">
        <button className="remote-skip-btn" onClick={() => handleSkip(-10)} disabled={isDisabled}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/>
          </svg>
          <span>10</span>
        </button>
        <button className="remote-play-btn" onClick={handleTogglePlay} disabled={isDisabled}>
          {isPlaying ? (
            <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>
        <button className="remote-skip-btn" onClick={() => handleSkip(10)} disabled={isDisabled}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <path d="M11.5 8c2.65 0 5.05.99 6.9 2.6L22 7v9h-9l3.62-3.62C15.23 11.22 13.46 10.5 11.5 10.5c-3.54 0-6.55 2.31-7.6 5.5L1.53 15.22C2.92 11.03 6.85 8 11.5 8z"/>
          </svg>
          <span>10</span>
        </button>
      </div>

      {state?.introActive && state?.introEnd && (
        <button
          className="remote-skip-intro"
          onClick={() => sendCommand("skip-intro")}
          disabled={isDisabled}
        >
          Skip Intro
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </button>
      )}

      {(state?.dlProgress ?? 1) < 1 && (
        <div className="remote-torrent-info">
          {state.dlSpeed > 0 && <span>{formatBytes(state.dlSpeed)}/s</span>}
          {state.dlPeers > 0 && <span>{state.dlPeers} peer{state.dlPeers !== 1 ? "s" : ""}</span>}
          <span>{Math.round((state.dlProgress || 0) * 100)}%</span>
        </div>
      )}

      <div className="remote-seek-area">
        <span className="remote-time">{formatTime(ct)}</span>
        <div
          className="remote-seek-bar"
          ref={seekBarRef}
          onMouseDown={isReconnecting ? undefined : onSeekStart}
          onTouchStart={isReconnecting ? undefined : onSeekStart}
        >
          <div className="remote-seek-track">
            <div className="remote-seek-downloaded" style={{ width: `${dlPct}%` }} />
            <div className="remote-seek-fill" style={{ width: `${progress}%` }} />
            <div className="remote-seek-thumb" style={{ left: `${progress}%` }} />
          </div>
        </div>
        <span className="remote-time">{formatTime(dur)}</span>
      </div>

      {/* AUDIO */}
      <section className="remote-section">
        <div className="remote-section-label">Audio</div>
        <div className="remote-control-row">
          <span className="remote-control-label">Volume</span>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="var(--text-muted)" aria-hidden="true">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
          </svg>
          <input
            type="range"
            className="remote-volume-slider"
            min="0" max="1" step="0.05"
            value={displayVolume}
            onChange={handleVolumeChange}
            disabled={isDisabled}
            aria-label="Volume"
          />
          <span className="remote-volume-value">{Math.round(displayVolume * 100)}%</span>
        </div>
        {state?.audioTracks?.length > 1 && (
          <div className="remote-control-row">
            <span className="remote-control-label">Track</span>
            <select
              className="remote-sub-select"
              value={state.activeAudio ?? ""}
              onChange={(e) => sendCommand("audio", parseInt(e.target.value, 10))}
              disabled={isDisabled}
              aria-label="Audio track"
            >
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {state.audioTracks.map((t: any) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
        )}
      </section>

      {/* SUBTITLES */}
      {state?.subs?.length > 0 && (
        <section className="remote-section">
          <div className="remote-section-label">Subtitles</div>
          <div className="remote-control-row">
            <span className="remote-control-label">Track</span>
            <select
              className="remote-sub-select"
              value={state.activeSub || ""}
              onChange={(e) => sendCommand("subtitle", e.target.value)}
              disabled={isDisabled}
              aria-label="Subtitle track"
            >
              <option value="">Off</option>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {state.subs.map((s: any) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div className="remote-sub-controls-row">
            <div className="remote-sub-control">
              <span className="remote-sub-control-label">Size</span>
              <div className="remote-stepper">
                <button onClick={() => sendCommand("sub-size", -5)} disabled={isDisabled} aria-label="Decrease subtitle size">A−</button>
                <span className="remote-stepper-value">{state.subSize ?? 55}</span>
                <button onClick={() => sendCommand("sub-size", 5)} disabled={isDisabled} aria-label="Increase subtitle size">A+</button>
              </div>
            </div>
            <div className="remote-sub-control">
              <span className="remote-sub-control-label">Delay</span>
              <div className="remote-stepper">
                <button onClick={() => sendCommand("sub-delay", -0.1)} disabled={isDisabled} aria-label="Decrease subtitle delay">−0.1s</button>
                <span className={`remote-stepper-value${(state.subDelay ?? 0) !== 0 ? " active" : ""}`}>{(state.subDelay ?? 0).toFixed(1)}s</span>
                <button onClick={() => sendCommand("sub-delay", 0.1)} disabled={isDisabled} aria-label="Increase subtitle delay">+0.1s</button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* CONTENT */}
      {(() => {
        const hasMultiSource = state?.sources?.length > 1;
        const isTv = state?.mediaType === "tv" && state?.tmdbId;
        const next = isTv && state?.season > 0 && state?.episode > 0
          ? nextEpisodeFrom({
              season: state.season,
              episode: state.episode,
              seasonEpisodeCount: state.seasonEpisodeCount || undefined,
              seasonCount: state.seasonCount || undefined,
            })
          : null;
        if (!hasMultiSource && !isTv) return null;
        return (
          <section className="remote-section">
            <div className="remote-section-label">Content</div>
            <div className="remote-content-row">
              {isTv && (
                <button
                  className={`remote-content-btn${showEpisodes ? " active" : ""}`}
                  onClick={() => { if (!showEpisodes) openEpisodeBrowser(); else setShowEpisodes(false); setShowSources(false); }}
                  disabled={isDisabled}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                    <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z" />
                  </svg>
                  <span className="remote-content-btn-label">Episodes</span>
                  {state.season > 0 && <span className="remote-content-btn-meta">S{state.season}E{state.episode}</span>}
                </button>
              )}
              {next && (
                <button
                  className="remote-content-btn"
                  onClick={() => sendCommand("next-episode", { season: next.season, episode: next.episode })}
                  disabled={isDisabled}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                    <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                  </svg>
                  <span className="remote-content-btn-label">Next Ep</span>
                  <span className="remote-content-btn-meta">S{next.season}E{next.episode}</span>
                </button>
              )}
              {hasMultiSource && (
                <button
                  className={`remote-content-btn${showSources ? " active" : ""}`}
                  onClick={() => { setShowSources((v) => !v); setShowEpisodes(false); }}
                  disabled={isDisabled}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                    <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" />
                  </svg>
                  <span className="remote-content-btn-label">Sources</span>
                  <span className="remote-content-btn-meta">{state.sources.length}</span>
                </button>
              )}
            </div>
          </section>
        );
      })()}

      {showSources && state?.sources?.length > 1 && (
        <div className="remote-sources-panel">
          {state.sources.map((s: any) => {
            const isCurrent = s.infoHash === state.infoHash;
            return (
              <button
                key={s.infoHash}
                className={`remote-source-item${isCurrent ? " active" : ""}`}
                onClick={() => {
                  if (!isCurrent) {
                    sendCommand("switch-source", s);
                    setShowSources(false);
                  }
                }}
              >
                <div className="remote-source-item-name">
                  {s.name}
                </div>
                <div className="remote-source-item-meta">
                  {isCurrent && <span className="remote-source-tag current">Playing</span>}
                  {s.tags?.filter((t: string) => t !== "Native").map((t: string) => (
                    <span key={t} className="remote-source-tag">{t}</span>
                  ))}
                  <span className="remote-source-seeds">
                    <span className="remote-source-seed-dot" />
                    {s.seeders ?? "?"}
                  </span>
                  {s.size > 0 && <span className="remote-source-size">{formatBytes(s.size)}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {showEpisodes && state?.mediaType === "tv" && (
        <div className="remote-episodes-panel">
          {(state.seasonCount > 1 || epBrowserSeason !== state.season) && (
            <div className="remote-episodes-season-bar">
              {Array.from({ length: state.seasonCount || 1 }, (_, i) => i + 1).map((s) => (
                <button
                  key={s}
                  className={`remote-episodes-season-btn${s === epBrowserSeason ? " active" : ""}`}
                  onClick={() => switchEpBrowserSeason(s)}
                >
                  S{s}
                </button>
              ))}
            </div>
          )}
          <div className="remote-episodes-list">
            {epBrowserEps === null ? (
              <div className="remote-episodes-loading"><div className="remote-spinner" /></div>
            ) : epBrowserEps.length === 0 ? (
              <div className="remote-episodes-empty">No episodes found</div>
            ) : (
              epBrowserEps.map((ep: any) => {
                const epKey = `s${epBrowserSeason}e${ep.episode_number}`;
                const prog = epProgress.get(epKey);
                const pct = prog && prog.duration > 0 ? Math.min(100, (prog.position / prog.duration) * 100) : 0;
                const isCurrent = epBrowserSeason === state.season && ep.episode_number === state.episode;
                return (
                  <button
                    key={ep.id}
                    className={`remote-ep-item${isCurrent ? " current" : ""}${prog?.finished ? " watched" : ""}`}
                    onClick={() => playEpisode(epBrowserSeason, ep.episode_number)}
                    disabled={isDisabled || isCurrent}
                  >
                    <span className="remote-ep-num">E{ep.episode_number}</span>
                    <div className="remote-ep-info">
                      <span className="remote-ep-title">{ep.name}</span>
                      {ep.runtime && <span className="remote-ep-runtime">{ep.runtime}m</span>}
                    </div>
                    {isCurrent && (
                      <span className="remote-ep-playing">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                      </span>
                    )}
                    {prog?.finished && !isCurrent && (
                      <svg className="remote-ep-check" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                      </svg>
                    )}
                    {pct > 0 && !prog?.finished && (
                      <div className="remote-ep-progress">
                        <div className="remote-ep-progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* BINGE MODE */}
      {sessionId && (
        <section className="remote-section">
          <div className="remote-binge-header">
            <div className="remote-section-label">
              Binge Mode
              <span className="remote-binge-beta">BETA</span>
            </div>
            <button
              type="button"
              className={`remote-switch${bingeMode.enabled ? " on" : ""}`}
              onClick={() => setBingeMode(sessionId, !bingeMode.enabled)}
              disabled={isDisabled}
              role="switch"
              aria-checked={bingeMode.enabled}
              aria-label="Toggle binge mode"
            />
          </div>
          {!bingeMode.enabled && (
            <p className="remote-binge-help">
              Auto-skip intros and credits, auto-advance to the next episode, and keep your audio/subtitle picks across episodes.
            </p>
          )}
          {bingeFlash && <div className="remote-flash">{bingeFlash}</div>}
          {bingeMode.enabled && bingeMode.capabilities && (() => {
            const c = bingeMode.capabilities;
            const features = [
              { key: "intro", label: "Auto-skip intro", enabled: c.autoSkipIntro.enabled, source: c.autoSkipIntro.source },
              { key: "credits", label: "Auto-skip credits", enabled: c.autoSkipCredits.enabled, source: `${c.autoSkipCredits.source}${c.autoSkipCredits.sampleCount != null ? ` (${c.autoSkipCredits.sampleCount} sample${c.autoSkipCredits.sampleCount === 1 ? "" : "s"})` : ""}` },
              { key: "tracks", label: "Persist audio/subs", enabled: c.persistTracks.enabled, source: "" },
              { key: "advance", label: `Auto-advance${c.autoAdvance.viaEOF ? " on EOF" : ""}`, enabled: c.autoAdvance.enabled, source: "" },
              { key: "prefetch", label: "Prefetch next episode", enabled: c.prefetch.enabled, source: c.prefetch.via ? `via ${c.prefetch.via}` : "" },
            ];
            const activeCount = features.filter((f) => f.enabled).length;
            return (
              <>
                <button
                  type="button"
                  className="remote-binge-features-toggle"
                  onClick={() => setShowBingeFeatures((s) => !s)}
                  aria-expanded={showBingeFeatures}
                >
                  <span>{showBingeFeatures ? "▾" : "▸"} Features</span>
                  <span className="remote-binge-features-count">{activeCount} of {features.length} active</span>
                </button>
                {showBingeFeatures && (
                  <div className="remote-binge-panel">
                    {features.map((f) => (
                      <div key={f.key} className="remote-binge-feature">
                        <span className={`remote-binge-feature-mark${f.enabled ? " on" : ""}`}>{symbolFor(f.enabled)}</span>
                        <span className="remote-binge-feature-label">{f.label}</span>
                        {f.source && <span className="remote-binge-source">{f.source}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
          {devMode && bingeMode.enabled && bingeMode.diagnostics && (
            <div className="remote-binge-debug">
              <button
                className="remote-binge-debug-toggle"
                onClick={() => setShowBingeDebug((s) => !s)}
                type="button"
              >
                {showBingeDebug ? "▾" : "▸"} Details
                <span className="remote-binge-debug-state">
                  state: {bingeMode.diagnostics.state}
                  {bingeMode.diagnostics.nextAction
                    ? ` → ${bingeMode.diagnostics.nextAction.kind}${bingeMode.diagnostics.nextAction.atTime != null ? ` @ ${fmtSec(bingeMode.diagnostics.nextAction.atTime)}` : ""}`
                    : ""}
                </span>
              </button>
              {showBingeDebug && (() => {
                const d = bingeMode.diagnostics!;
                const now = Date.now();
                return (
                  <div className="remote-binge-debug-body">
                    <div className="remote-binge-debug-section">
                      <div className="remote-binge-debug-section-title">Next action</div>
                      {d.nextAction ? (
                        <div>
                          <span className="remote-binge-debug-kind">{d.nextAction.kind}</span>
                          {d.nextAction.atTime != null && (
                            <span className="remote-binge-debug-time"> @ {fmtSec(d.nextAction.atTime)}</span>
                          )}
                          <div className="remote-binge-source">{d.nextAction.reason}</div>
                        </div>
                      ) : (
                        <div className="remote-binge-source">— no action scheduled</div>
                      )}
                    </div>
                    <div className="remote-binge-debug-section">
                      <div className="remote-binge-debug-section-title">Markers (duration {fmtSec(d.duration)})</div>
                      {d.markers ? (
                        <>
                          <div>
                            Intro: {d.markers.introStart != null ? `${fmtSec(d.markers.introStart)}–${fmtSec(d.markers.introEnd)}` : "—"}
                            <span className="remote-binge-source"> {d.markers.introSource}</span>
                          </div>
                          <div>
                            Outro: {d.markers.outroStart != null ? fmtSec(d.markers.outroStart) : "—"}
                            <span className="remote-binge-source"> {d.markers.outroSource}</span>
                          </div>
                        </>
                      ) : <div className="remote-binge-source">— not computed yet</div>}
                    </div>
                    <div className="remote-binge-debug-section">
                      <div className="remote-binge-debug-section-title">Signals</div>
                      <div>
                        Chapters:{" "}
                        {d.signals.chapters
                          ? <>
                              {d.signals.chapters.count} found
                              {d.signals.chapters.intro && ` · intro ${fmtSec(d.signals.chapters.intro.start)}–${fmtSec(d.signals.chapters.intro.end)}`}
                              {d.signals.chapters.outro && ` · outro ${fmtSec(d.signals.chapters.outro.start)}`}
                            </>
                          : <span className="remote-binge-source">none</span>}
                      </div>
                      <div>
                        AniSkip:{" "}
                        {d.signals.aniskip
                          ? <>
                              {d.signals.aniskip.op && `OP ${fmtSec(d.signals.aniskip.op.start)}–${fmtSec(d.signals.aniskip.op.end)}`}
                              {d.signals.aniskip.ed && ` · ED ${fmtSec(d.signals.aniskip.ed.start)}`}
                              {!d.signals.aniskip.durationMatch && <span className="remote-binge-source"> · duration mismatch</span>}
                              {d.signals.aniskip.resolution && (
                                <div className="remote-binge-source">
                                  MAL #{d.signals.aniskip.resolution.malId} · {d.signals.aniskip.resolution.jikanTitle || "(no Jikan title)"}
                                  {" · queried "}
                                  <span style={{ fontStyle: "italic" }}>"{d.signals.aniskip.resolution.jikanQuery}"</span>
                                  {!d.signals.aniskip.resolution.seasonSpecific && " · ⚠ season-ambiguous (fell back to base title)"}
                                </div>
                              )}
                            </>
                          : <span className="remote-binge-source">none</span>}
                      </div>
                      <div>
                        IntroDB:{" "}
                        {d.signals.introdb
                          ? <>
                              <span className="remote-binge-source">imdb {d.signals.introdb.imdbId}</span>
                              {d.signals.introdb.intro && (
                                <div>intro {fmtSec(d.signals.introdb.intro.start)}–{fmtSec(d.signals.introdb.intro.end)} (n={d.signals.introdb.intro.submissionCount}, c={d.signals.introdb.intro.confidence.toFixed(2)})</div>
                              )}
                              {d.signals.introdb.outro && (
                                <div>outro {fmtSec(d.signals.introdb.outro.start)}–{fmtSec(d.signals.introdb.outro.end)} (n={d.signals.introdb.outro.submissionCount}, c={d.signals.introdb.outro.confidence.toFixed(2)})</div>
                              )}
                              {!d.signals.introdb.intro && !d.signals.introdb.outro && (
                                <span className="remote-binge-source"> · no segments passed floor</span>
                              )}
                            </>
                          : <span className="remote-binge-source">none</span>}
                      </div>
                      <div>
                        Learned outro:{" "}
                        {d.signals.learnedOutro
                          ? `${fmtSec(d.signals.learnedOutro.offset)} (${d.signals.learnedOutro.sampleCount} sample${d.signals.learnedOutro.sampleCount === 1 ? "" : "s"})`
                          : <span className="remote-binge-source">none</span>}
                      </div>
                    </div>
                    <div className="remote-binge-debug-section">
                      <div className="remote-binge-debug-section-title">
                        Prefetch (fires @ {fmtSec((d.duration || 0) * d.prefetch.threshold)})
                      </div>
                      <div>
                        {d.prefetch.firedAtTime != null
                          ? <>fired @ {fmtSec(d.prefetch.firedAtTime)} · {d.prefetch.resolved ?? "in progress"}{d.prefetch.resolved === "ok" && ` · ready: ${d.prefetch.ready ? "yes" : "no"}`}</>
                          : <span className="remote-binge-source">not yet fired</span>}
                        {d.prefetch.error && <div className="remote-binge-source">error: {d.prefetch.error}</div>}
                      </div>
                    </div>
                    <div className="remote-binge-debug-section">
                      <div className="remote-binge-debug-section-title">Events (last {d.events.length})</div>
                      {d.events.length === 0
                        ? <div className="remote-binge-source">— none yet</div>
                        : [...d.events].reverse().map((e: BingeEvent, i) => (
                            <div key={i} className="remote-binge-debug-event">
                              <span className="remote-binge-debug-event-kind">{e.kind}</span>
                              {e.t != null && <span className="remote-binge-debug-event-t"> @ {fmtSec(e.t)}</span>}
                              <span className="remote-binge-source"> · {fmtRelative(e.at, now)}</span>
                              {e.detail && <div className="remote-binge-source">{e.detail}</div>}
                            </div>
                          ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </section>
      )}

      <div className="remote-bottom-row">
        <button className="remote-browse-btn" onClick={() => navigate("/")} disabled={isDisabled}>
          Browse
        </button>
        <button className="remote-stop-btn" onClick={() => sendCommand("stop-stream")} disabled={isDisabled}>
          Stop
        </button>
      </div>
    </div>
  );
}
