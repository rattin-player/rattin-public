import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { usePlayer } from "../lib/PlayerContext";
import { usePlayerLoading } from "../lib/usePlayerLoading";
import { useSubtitles } from "../lib/useSubtitles";
import { useAudioTracks } from "../lib/useAudioTracks";
import { useSeek } from "../lib/useSeek";
import { useIntro } from "../lib/useIntro";
import { formatTime, formatBytes } from "../lib/utils";
import { playTorrent, fetchLivePeers, fetchLanIp } from "../lib/api";
import { encode } from "uqr";
import { waitForBridge, mpvPlay, mpvTogglePause, mpvSeek, mpvSetVolume, mpvSetAudioTrack, mpvSetSubtitleTrack, mpvStop, mpvSetTitle, onMpvTimeChanged, onMpvDurationChanged, onMpvEofReached, onMpvPauseChanged, onNativeSubChanged, onNativeAudioChanged, onNativeVolumeChanged, onNativeSubSizeChanged } from "../lib/native-bridge";
import "./Player.css";

export default function Player() {
  const { infoHash, fileIndex } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { startStream, stopStream, active, effectiveTimeRef, subsRef, activeSubRef, audioTracksRef, activeAudioRef, commandRef, dlProgressRef, dlSpeedRef, dlPeersRef, rcSessionId, rcAuthToken, rcRemoteConnected, rcQrRequested, setRcSessionId, setRcAuthToken, introRangeRef, volume, sourcesRef, subSize, adjustSubSize, togglePlay } = usePlayer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = location.state as any;
  const [currentTags, setCurrentTags] = useState<string[]>(state?.tags || []);
  const [currentTitle, setCurrentTitle] = useState<string>(state?.title || "");
  const tags: string[] = currentTags.length > 0 ? currentTags : (active?.tags || []);
  const mediaTitle: string = currentTitle || active?.title || "";
  const preSelectedAudio: number | null = state?.audioTrack ?? null;
  const preSelectedSub: string | null = state?.subtitle ?? null;
  const pageRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Source switcher state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [sources, setSources] = useState<any[]>(state?.sources || []);
  sourcesRef.current = sources;
  const [showSources, setShowSources] = useState(false);
  const [switchingSource, setSwitchingSource] = useState<string | null>(null);
  const [livePeers, setLivePeers] = useState<Record<string, { numPeers: number; downloadSpeed: number }>>({});
  const livePeerTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // Poll live peers only for the currently playing torrent
  useEffect(() => {
    if (!showSources || !active?.infoHash) {
      clearInterval(livePeerTimer.current);
      return;
    }
    const poll = () => {
      fetchLivePeers([active.infoHash]).then(setLivePeers).catch(() => {});
    };
    poll();
    livePeerTimer.current = setInterval(poll, 3000);
    return () => clearInterval(livePeerTimer.current);
  }, [showSources, active?.infoHash]);

  // Switch to a different source
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSwitchSource = useCallback(async (source: any) => {
    if (source.infoHash === active?.infoHash) {
      setShowSources(false);
      return;
    }
    setSwitchingSource(source.infoHash);
    try {
      // Start the new torrent
      const result = await playTorrent(
        source.infoHash, source.name,
        state?.pickerSeason, state?.pickerEpisode,
      );
      const newTags = result.tags || source.tags || [];
      setCurrentTags(newTags);
      // Navigate to the new stream URL (replace so back button goes to detail)
      navigate(`/play/${result.infoHash}/${result.fileIndex}`, {
        replace: true,
        state: {
          ...state,
          tags: newTags,
          sources,
          debridUrl: result.debridUrl,
        },
      });
      // Start the new stream
      startStream(result.infoHash, result.fileIndex, mediaTitle, newTags, result.debridUrl);
      setShowSources(false);
    } catch {
      // If switch fails, stay on current
    } finally {
      setSwitchingSource(null);
    }
  }, [active, startStream, navigate, state, sources, mediaTitle]);

  const {
    loading, setLoading, loadingReason, setLoadingReason,
    loadingMsg, currentMessage, pendingSubReload, reloadActiveSubRef, MESSAGES: _MESSAGES,
  } = usePlayerLoading({ infoHash: infoHash!, fileIndex: fileIndex!, reloadActiveSub: null });

  const {
    currentTime, duration, playing,
    dlProgress, dlSpeed, numPeers, fileName,
    tooltipTime, tooltipX,
    getEffectiveTime,
    seekTo, handleSeekClick, handleSeekHover,
    setPlaying, setTooltipTime,
  } = useSeek({
    infoHash: infoHash!, fileIndex: fileIndex!,
    effectiveTimeRef, dlProgressRef, dlSpeedRef, dlPeersRef,
    seekRef,
  });

  const {
    subs, activeSub, switchSubtitle, reloadActiveSub,
  } = useSubtitles({
    infoHash: infoHash!, fileIndex: fileIndex!, subsRef, activeSubRef,
    preSelectedSub,
  });

  // Wire reloadActiveSub into usePlayerLoading now that it's available
  reloadActiveSubRef.current = reloadActiveSub;

  const { audioTracks, activeAudio, switchAudio } = useAudioTracks({
    infoHash: infoHash!, fileIndex: fileIndex!, audioTracksRef, activeAudioRef,
    preSelectedAudio,
  });

  const { introRange, showSkipIntro, handleSkipIntro } = useIntro({
    infoHash: infoHash!, fileIndex: fileIndex!, introRangeRef, getEffectiveTime, seekTo, location, mediaTitle,
  });

  // Detect stuck/slow source — show warning after 15s of 0 speed while incomplete
  const [showSlowWarning, setShowSlowWarning] = useState(false);
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(stuckTimer.current);
    if (dlProgress >= 1 || dlSpeed > 0 || !active) {
      setShowSlowWarning(false);
      return;
    }
    // Start timer when speed is 0 and download isn't complete
    stuckTimer.current = setTimeout(() => setShowSlowWarning(true), 15000);
    return () => clearTimeout(stuckTimer.current);
  }, [dlSpeed, dlProgress, active]);

  // Sync PlayerContext.active with URL params (Detail.tsx navigates here without calling startStream)
  useEffect(() => {
    if (!infoHash || !fileIndex) return;
    if (active?.infoHash !== infoHash || String(active?.fileIndex) !== String(fileIndex)) {
      startStream(infoHash, fileIndex, mediaTitle, tags, state?.debridUrl);
    }
  }, [infoHash, fileIndex]);

  // Native mode: tell mpv to play
  useEffect(() => {
    if (!infoHash || !fileIndex) return;
    let cancelled = false;

    waitForBridge().then(() => {
      if (cancelled) return;
      // Use 127.0.0.1 instead of localhost — mpv is a separate process and
      // localhost may resolve to ::1 (IPv6) while the server binds to 127.0.0.1
      const port = window.location.port;
      const debridUrl = state?.debridUrl;
      const streamUrl = debridUrl
        ? debridUrl
        : `http://127.0.0.1:${port}/api/stream/${infoHash}/${fileIndex}`;
      console.log("[native-bridge] mpvPlay:", streamUrl);
      try {
        mpvSetTitle(mediaTitle || "");
        mpvPlay(streamUrl);
        console.log("[native-bridge] mpvPlay sent");
      } catch (e) {
        console.error("[native-bridge] mpvPlay error:", e);
      }

      // Register event handlers AFTER bridge is ready (window.mpvEvents
      // doesn't exist until waitForBridge resolves)
      onMpvTimeChanged((t) => {
        const prev = effectiveTimeRef.current;
        effectiveTimeRef.current = { time: t, duration: prev?.duration ?? 0, ts: Date.now() };
        setLoading(false);
      });
      onMpvDurationChanged((d) => {
        const prev = effectiveTimeRef.current;
        effectiveTimeRef.current = { time: prev?.time ?? 0, duration: d, ts: Date.now() };
        setLoading(false);
      });
      onMpvEofReached(() => {
        navigate(-1);
      });
      onMpvPauseChanged((paused) => {
        setPlaying(!paused);
      });
      // Sync React subtitle/audio state when QML native overlay changes tracks
      onNativeSubChanged((mpvId) => {
        if (mpvId === 0) {
          switchSubtitle("");
        } else {
          // mpv IDs are 1-based, find the matching sub by index in the subs array
          const match = subs[mpvId - 1];
          if (match) switchSubtitle(match.value);
        }
      });
      onNativeAudioChanged((mpvId) => {
        // Only update React state — mpv already switched the track.
        activeAudioRef.current = mpvId;
      });
      onNativeVolumeChanged((percent) => {
        if (percent > 0) setMuted(false);
      });
      onNativeSubSizeChanged((size) => {
        adjustSubSize(size - subSize);
      });
    }).catch((e) => console.error("[native-bridge] waitForBridge error:", e));

    return () => {
      cancelled = true;
      if (window.mpvEvents) {
        window.mpvEvents.onEofReached = null;
        window.mpvEvents.onTimeChanged = null;
        window.mpvEvents.onDurationChanged = null;
        window.mpvEvents.onPauseChanged = null;
        window.mpvEvents.onNativeSubChanged = null;
        window.mpvEvents.onNativeAudioChanged = null;
        window.mpvEvents.onNativeVolumeChanged = null;
        window.mpvEvents.onNativeSubSizeChanged = null;
      }
      mpvStop();
    };
  }, [infoHash, fileIndex]);

  // Register command handlers for remote control (assigned every render to avoid stale closures)
  if (commandRef) {
    commandRef.current = {
      seek: (seconds: number) => {
        mpvSeek(seconds);
      },
      seekRelative: (delta: number) => {
        const t = effectiveTimeRef.current?.time ?? 0;
        mpvSeek(Math.max(0, t + delta));
      },
      switchSubtitle: (val: string) => {
        const idx = subs.findIndex(s => s.value === val);
        mpvSetSubtitleTrack(idx);
        activeSubRef.current = val;
      },
      switchAudio: (streamIndex: string | number) => {
        const idx = audioTracks.findIndex(t => t.value === Number(streamIndex));
        if (idx >= 0) mpvSetAudioTrack(idx);
        activeAudioRef.current = typeof streamIndex === "string" ? parseInt(streamIndex, 10) : streamIndex;
      },
      switchSource: handleSwitchSource,
    };
  }
  useEffect(() => {
    return () => { if (commandRef) commandRef.current = null; };
  }, []);

  const [showControls, setShowControls] = useState(true);
  const [muted, setMuted] = useState(false);

  function showControlsBriefly() {
    setShowControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowControls(false), 3000);
  }

  // Use document-level mousemove for fullscreen reliability
  useEffect(() => {
    function onMove() { showControlsBriefly(); }
    document.addEventListener("mousemove", onMove);
    return () => document.removeEventListener("mousemove", onMove);
  }, []);

  function handlePageClick(e: React.MouseEvent) {
    // If clicking the video area (not a control), toggle play and show controls
    if (loading) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "BUTTON" || tag === "SELECT" || tag === "OPTION" || tag === "SVG" || tag === "PATH") return;
    togglePlay();
    showControlsBriefly();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (loading) return;
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
      switch (e.key) {
        case " ": e.preventDefault();
          mpvTogglePause();
          break;
        case "ArrowLeft":
          mpvSeek(Math.max(0, getEffectiveTime() - 10));
          break;
        case "ArrowRight":
          mpvSeek(getEffectiveTime() + 10);
          break;
        case "f": case "F":
          if (document.fullscreenElement) document.exitFullscreen();
          else pageRef.current?.requestFullscreen?.();
          break;
        case "Escape":
          if (document.fullscreenElement) document.exitFullscreen();
          break;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const playedPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  // Auto-create a new session when remote disconnects during playback
  // This ensures a QR is always available for the phone to scan
  const hadRemote = useRef(false);
  useEffect(() => {
    if (rcRemoteConnected) {
      hadRemote.current = true;
      return;
    }
    // Remote just disconnected — if we had one before, ensure we have a session for the QR
    if (!hadRemote.current) return;
    // Check if existing session is still valid, if not create a new one
    async function ensureSession() {
      if (rcSessionId) {
        try {
          const res = await fetch(`/api/rc/session/${rcSessionId}`);
          if (res.ok) return; // session still alive, QR will show
        } catch {}
      }
      // Session gone or never existed — create one
      try {
        const res = await fetch("/api/rc/session", { method: "POST" });
        const data = await res.json();
        setRcSessionId(data.sessionId);
        setRcAuthToken(data.authToken);
      } catch {}
    }
    ensureSession();
  }, [rcRemoteConnected]);

  // Auto-fullscreen when a remote reconnects
  useEffect(() => {
    if (rcRemoteConnected && hadRemote.current) {
      if (!document.fullscreenElement) {
        pageRef.current?.requestFullscreen?.().catch(() => {});
      }
    }
  }, [rcRemoteConnected]);

  // Toast when remote connects/disconnects
  const [remoteToast, setRemoteToast] = useState<string | null>(null);
  const prevRemoteConnected = useRef(rcRemoteConnected);
  useEffect(() => {
    if (rcRemoteConnected && !prevRemoteConnected.current) {
      setRemoteToast("connected");
      const t = setTimeout(() => setRemoteToast(null), 3000);
      return () => clearTimeout(t);
    }
    if (!rcRemoteConnected && prevRemoteConnected.current) {
      setRemoteToast("disconnected");
      const t = setTimeout(() => setRemoteToast(null), 3000);
      return () => clearTimeout(t);
    }
    prevRemoteConnected.current = rcRemoteConnected;
  }, [rcRemoteConnected]);

  // Generate QR code for remote reconnection — only when phone explicitly requests it
  const showReconnectQr = rcSessionId && rcAuthToken && rcQrRequested && !rcRemoteConnected;
  const [reconnectOrigin, setReconnectOrigin] = useState<string | null>(null);
  useEffect(() => {
    if (!showReconnectQr) { setReconnectOrigin(null); return; }
    fetchLanIp()
      .then(({ ip, port }) => setReconnectOrigin(ip ? `http://${ip}:${port}` : window.location.origin))
      .catch(() => setReconnectOrigin(window.location.origin));
  }, [showReconnectQr]);
  const reconnectQrSvg = useMemo(() => {
    if (!showReconnectQr || !reconnectOrigin) return null;
    const url = `${reconnectOrigin}/api/rc/auth?session=${rcSessionId}&token=${rcAuthToken}`;
    try {
      const { data, size } = encode(url, { ecc: "L" });
      const mod = 3;
      const margin = 4;
      const total = size * mod + margin * 2;
      let paths = "";
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
          if (data[y][x])
            paths += `M${margin + x * mod},${margin + y * mod}h${mod}v${mod}h-${mod}z`;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"><rect width="${total}" height="${total}" fill="#fff" rx="4"/><path d="${paths}" fill="#000"/></svg>`;
    } catch { return null; }
  }, [showReconnectQr, reconnectOrigin, rcSessionId, rcAuthToken]);

  return (
    <div className="player-page" ref={pageRef} onClick={handlePageClick}>

      {remoteToast && (
        <div className={`player-remote-toast ${remoteToast}`} key={remoteToast}>
          <span className="player-remote-toast-dot" />
          {remoteToast === "connected" ? "Remote connected" : "Remote disconnected"}
        </div>
      )}

      {loading && (
        <div className={`player-loading${showSources ? " sources-open" : ""}`}>
          <button className="player-loading-back" onClick={() => navigate(-1)}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
            </svg>
          </button>
          {sources.length > 1 && (
            <button className="player-loading-sources" onClick={() => setShowSources(true)}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" />
              </svg>
              Switch Source
            </button>
          )}
          <div className="player-loading-center">
            <div className="player-loading-spinner" />
            <p className="player-loading-msg" key={`${loadingReason}-${loadingMsg}`}>
              {currentMessage}
            </p>
          </div>
        </div>
      )}

      {showSkipIntro && introRange && (
        <button
          className="player-skip-intro"
          onClick={(e) => { e.stopPropagation(); handleSkipIntro(); }}
        >
          Skip Intro
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </button>
      )}

      {showSlowWarning && sources.length > 1 && !showSources && (
        <div className="player-slow-warning" onClick={(e) => e.stopPropagation()}>
          <span>No data from peers — source may be dead</span>
          <button onClick={() => setShowSources(true)}>Switch Source</button>
        </div>
      )}

      <div className={`player-overlay ${showControls ? "visible" : ""}${loading ? " disabled" : ""}`}>
        <div className="player-top" onClick={(e) => e.stopPropagation()}>
          <button className="player-back" onClick={() => navigate(-1)}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
            </svg>
          </button>
          <span className="player-title">{mediaTitle || fileName}</span>
          {tags.length > 0 && (
            <div className="player-tags">
              {tags.map((t) => <span key={t} className="player-tag">{t}</span>)}
            </div>
          )}
        </div>

        <div className="player-bottom" onClick={(e) => e.stopPropagation()}>
          <div
            className="player-seek"
            ref={seekRef}
            onClick={handleSeekClick}
            onMouseMove={handleSeekHover}
            onMouseLeave={() => setTooltipTime(null)}
          >
            <div className="seek-downloaded" style={{ width: `${dlProgress * 100}%` }} />
            <div className="seek-played" style={{ width: `${playedPct}%` }} />
            {tooltipTime !== null && (
              <div className="seek-tooltip" style={{ left: `${tooltipX}%` }}>
                {formatTime(tooltipTime)}
              </div>
            )}
          </div>

          <div className="player-controls">
            <button className="player-playpause" onClick={togglePlay}>
              {playing ? (
                <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              )}
            </button>
            <span className="player-time">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
            {dlProgress < 1 && (
              <span className="player-dl-info">
                {formatBytes(dlSpeed)}/s &middot; {numPeers} peer{numPeers !== 1 ? "s" : ""} &middot; {Math.round(dlProgress * 100)}%
              </span>
            )}
            <div className="player-spacer" />
            <div className="player-volume">
              <button className="player-volume-icon" onClick={() => {
                if (muted) {
                  mpvSetVolume(Math.round(volume * 100) || 50);
                  setMuted(false);
                } else {
                  mpvSetVolume(0);
                  setMuted(true);
                }
              }}>
                {muted || volume === 0 ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" /></svg>
                ) : volume < 0.5 ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" /></svg>
                )}
              </button>
              <input
                type="range"
                className="player-volume-slider"
                min="0" max="1" step="0.05"
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  mpvSetVolume(Math.round(val * 100));
                  if (val > 0) setMuted(false);
                }}
              />
            </div>
            {subs.length > 0 && (
              <select
                className="player-sub-select"
                value={activeSub}
                onChange={(e) => switchSubtitle(e.target.value)}
              >
                <option value="">Subtitles Off</option>
                {subs.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            )}
            {subs.length > 0 && (
              <div className="player-sub-size">
                <button className="player-sub-size-btn" onClick={() => adjustSubSize(-5)} title="Decrease subtitle size">A−</button>
                <span className="player-sub-size-val">{subSize}</span>
                <button className="player-sub-size-btn" onClick={() => adjustSubSize(5)} title="Increase subtitle size">A+</button>
              </div>
            )}
            {audioTracks.length > 1 && (
              <select
                className="player-sub-select"
                value={activeAudio ?? ""}
                onChange={(e) => switchAudio(e.target.value)}
              >
                {audioTracks.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            )}
            {sources.length > 1 && (
              <button
                className="player-source-btn"
                onClick={() => setShowSources((v) => !v)}
                title="Switch source"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" />
                </svg>
              </button>
            )}
            <button
              className="player-fullscreen"
              onClick={() => {
                if (document.fullscreenElement) document.exitFullscreen();
                else pageRef.current?.requestFullscreen?.();
              }}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {showSources && sources.length > 1 && (
        <div className="player-sources-overlay" onClick={() => setShowSources(false)}>
          <div className="player-sources-panel" onClick={(e) => e.stopPropagation()}>
            <div className="player-sources-header">
              <h3>Switch Source</h3>
              <button className="player-sources-close" onClick={() => setShowSources(false)}>&#10005;</button>
            </div>
            <div className="player-sources-list">
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {sources.map((s: any) => {
                const isCurrent = s.infoHash === active?.infoHash;
                const live = isCurrent ? livePeers[s.infoHash] : null;
                const isSwitching = switchingSource === s.infoHash;
                return (
                  <button
                    key={s.infoHash}
                    className={`player-source-item${isCurrent ? " active" : ""}`}
                    onClick={() => handleSwitchSource(s)}
                    disabled={isSwitching}
                  >
                    <div className="player-source-item-main">
                      <span className="player-source-item-name">{s.name}</span>
                      <div className="player-source-item-tags">
                        {isCurrent && <span className="player-source-tag current">Playing</span>}
                        {s.seasonPack && <span className="player-source-tag season-pack">Season Pack</span>}
                        {s.tags?.filter((t: string) => t !== "Native").map((t: string) => (
                          <span key={t} className="player-source-tag">{t}</span>
                        ))}
                        {s.multiAudio && <span className="player-source-tag multi-audio">Multi Audio</span>}
                        {s.hasSubs && <span className="player-source-tag has-subs">Subs</span>}
                        {s.foreignOnly && <span className="player-source-tag foreign">Foreign</span>}
                        {s.languages?.length > 0 && (
                          <span className="player-source-tag languages">{s.languages.join(" ")}</span>
                        )}
                      </div>
                    </div>
                    <div className="player-source-item-meta">
                      <span className="player-source-provider">{s.source?.toUpperCase()}</span>
                      <span className="player-source-seeds">
                        <span className="player-source-seed-dot" />
                        {live ? live.numPeers : s.seeders}
                        {live && <span className="player-source-seed-label">live</span>}
                      </span>
                      <span className="player-source-size">{formatBytes(s.size)}</span>
                      {isSwitching && <span className="player-source-switching">Switching...</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {showReconnectQr && reconnectQrSvg && (
        <div className="player-reconnect-qr-overlay" onClick={(e) => e.stopPropagation()}>
          <div className="player-reconnect-qr-card">
            <div className="player-reconnect-qr-inner" dangerouslySetInnerHTML={{ __html: reconnectQrSvg }} />
            <span className="player-reconnect-qr-label">Scan to reconnect remote</span>
          </div>
        </div>
      )}
    </div>
  );
}
