// ── Player.tsx — Logic wrapper for native mpv playback ──
//
// IMPORTANT: This is NOT a web video player. Video playback is handled by a
// native mpv process rendered via an OpenGL surface in the Qt/QML shell
// (shell/main.qml). The mpv surface sits on top of this WebEngineView at z:3.
//
// What this component DOES:
//   - Tells mpv what to play (mpvPlay) via the QWebChannel bridge (lib/native-bridge.ts)
//   - Manages React state: stream lifecycle, watch history, subtitle/audio track
//     selection, source switching, remote control session, intro skip detection
//   - Syncs React state ↔ QML state via bridge signals (e.g. when QML's native
//     overlay changes the subtitle track, React is notified via onNativeSubChanged)
//   - Renders the source picker panel (React UI shown when mpv surface is hidden)
//
// What this component does NOT do:
//   - Render video — mpv does that natively in QML (MpvObject in main.qml)
//   - Show playback controls — the QML controlsOverlay handles play/pause,
//     seek bar, volume, CC, fullscreen (all rendered on top of the mpv surface)
//   - Show loading/buffering UI — QML splash overlay handles that
//
// Architecture:
//   React (Player.tsx) ←→ native-bridge.ts ←→ QWebChannel ←→ QML (main.qml) ←→ mpv (C++)
//   Commands flow left→right (mpvPlay, mpvSeek, mpvStop)
//   Events flow right→left (onMpvTimeChanged, onMpvPauseChanged, onBackRequested)
//
// See also: shell/main.qml (QML overlay + mpv), shell/mpvbridge.cpp (C++ mpv wrapper),
//           src/lib/native-bridge.ts (JS↔QML bridge layer)

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { usePlayer } from "../lib/PlayerContext";
import { useSubtitles } from "../lib/useSubtitles";
import { useAudioTracks } from "../lib/useAudioTracks";
import { useSeek } from "../lib/useSeek";
import { useIntro } from "../lib/useIntro";
import { formatBytes } from "../lib/utils";
import { playTorrent, fetchLivePeers, fetchLanIp, searchStreams, autoPlay, fetchSeason, reportWatchProgress } from "../lib/api";
import { encode } from "uqr";
import { waitForBridge, mpvPlay, mpvSeek, mpvSetAudioTrack, mpvSetSubtitleTrack, mpvLoadExternalSubtitle, mpvStop, mpvStopAndWait, mpvSetTitle, onMpvTimeChanged, onMpvDurationChanged, onMpvEofReached, onMpvPauseChanged, onNativeSubChanged, onNativeAudioChanged, onNativeSubSizeChanged, onNativeSubDelayChanged, onBackRequested, onToggleSourcePanel, mpvSetSourceCount, mpvNotifySourcePanel, mpvSetPoster, mpvSetLoading, mpvSetLoadingStatus, mpvSetSlowWarning } from "../lib/native-bridge";
import { playbackKey, shouldRestorePosition } from "../lib/playback-position";
import "./Player.css";

export default function Player() {
  const { infoHash, fileIndex } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { startStream, active, effectiveTimeRef, subsRef, activeSubRef, audioTracksRef, activeAudioRef, commandRef, dlProgressRef, dlSpeedRef, dlPeersRef, rcSessionId, rcAuthToken, rcRemoteConnected, rcQrRequested, setRcSessionId, setRcAuthToken, introRangeRef, episodeInfoRef, sourcesRef, subSize, adjustSubSize, setSubSizeAbsolute, subDelayRef } = usePlayer();
  // Persist nav state to sessionStorage — location.state can be null on subsequent navigations
  // to the same URL in Qt WebEngine. Memoized to prevent new object reference every render.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ls = location.state as any;
    const key = `playerState:${infoHash}:${fileIndex}`;
    if (ls?.tmdbId) {
      try { sessionStorage.setItem(key, JSON.stringify(ls)); } catch {}
      return ls;
    }
    try {
      const saved = sessionStorage.getItem(key);
      if (saved) return JSON.parse(saved);
    } catch {}
    return ls;
  }, [infoHash, fileIndex, location.state]);
  const [currentTags, setCurrentTags] = useState<string[]>(state?.tags || []);
  const tags: string[] = currentTags.length > 0 ? currentTags : (active?.tags || []);
  const mediaTitle: string = state?.title || active?.title || "";
  const preSelectedAudio: number | null = state?.audioTrack ?? null;
  const preSelectedSub: string | null = state?.subtitle ?? null;
  const pageRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef<HTMLDivElement>(null);

  // Source switcher state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [sources, setSources] = useState<any[]>(state?.sources || []);
  sourcesRef.current = sources;
  const [showSources, setShowSources] = useState(false);
  const [switchingSource, setSwitchingSource] = useState<string | null>(null);
  const [livePeers, setLivePeers] = useState<Record<string, { numPeers: number; downloadSpeed: number }>>({});
  const livePeerTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // Fetch sources for current content (enables source picker on desktop + remote)
  useEffect(() => {
    if (!state?.title) return;
    // Clear stale sources from previous video, then fetch fresh ones
    setSources(state?.sources || []);
    if (state?.sources?.length > 0) return;
    searchStreams(state.title, state.year, state.type, state.season, state.episode, state.imdbId)
      .then((results) => { if (results.length > 0) setSources(results); })
      .catch(() => {});
  }, [infoHash]);

  // Tell QML how many sources are available (for showing/hiding source button)
  useEffect(() => {
    mpvSetSourceCount(sources.length);
  }, [sources.length]);

  // Notify QML when source panel opens/closes (hides/shows mpv surface)
  useEffect(() => {
    mpvNotifySourcePanel(showSources);
  }, [showSources]);

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

  // Switch to a different source — full stop-and-respawn like content switching
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSwitchSource = useCallback(async (source: any) => {
    if (source.infoHash === active?.infoHash) {
      setShowSources(false);
      return;
    }
    setSwitchingSource(source.infoHash);
    try {
      const result = await playTorrent(
        source.infoHash, source.name,
        state?.season, state?.episode,
      );
      const newTags = result.tags || source.tags || [];
      setCurrentTags(newTags);
      setShowSources(false);
      // Capture position BEFORE teardown — startStream nulls effectiveTimeRef
      const currentPos = effectiveTimeRef.current?.time ?? 0;
      // Kill old player, wait for mpv to fully stop, then spawn new player
      navigate("/", { replace: true });
      await mpvStopAndWait();
      startStream(result.infoHash, result.fileIndex, mediaTitle, newTags, result.debridStreamKey);
      navigate(`/play/${result.infoHash}/${result.fileIndex}`, {
        state: {
          ...state,
          tags: newTags,
          sources,
          debridStreamKey: result.debridStreamKey,
          resumePosition: currentPos > 10 ? currentPos : undefined,
        },
      });
    } catch {
      // If switch fails, stay on current
    } finally {
      setSwitchingSource(null);
    }
  }, [active, startStream, navigate, state, sources, mediaTitle]);

  const {
    dlProgress, dlSpeed, numPeers,
    getEffectiveTime,
    seekTo,
    setPlaying,
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


  const { audioTracks, activeAudio, switchAudio } = useAudioTracks({
    infoHash: infoHash!, fileIndex: fileIndex!, audioTracksRef, activeAudioRef,
    preSelectedAudio,
  });

  // Apply auto-selected audio track to mpv (hooks pick English, mpv needs to be told)
  const appliedAudio = useRef(false);
  useEffect(() => {
    if (appliedAudio.current || activeAudio === null || audioTracks.length < 2) return;
    const idx = audioTracks.findIndex(t => t.value === activeAudio);
    if (idx >= 0) {
      mpvSetAudioTrack(idx);
      appliedAudio.current = true;
    }
  }, [activeAudio, audioTracks]);

  // Apply auto-selected subtitle track to mpv
  const appliedSub = useRef(false);
  useEffect(() => {
    if (appliedSub.current || !activeSub) return;
    const idx = subs.findIndex(s => s.value === activeSub);
    if (idx < 0) return;
    const sub = subs[idx];
    // External subtitle: load via HTTP URL (sub-add with "select" activates it automatically)
    if (sub.value.startsWith("file:")) {
      const port = window.location.port;
      const subUrl = `http://127.0.0.1:${port}/api/subtitle/${infoHash}/${sub.fileIndex}`;
      mpvLoadExternalSubtitle(subUrl, sub.label);
      appliedSub.current = true;
    } else if (sub.value.startsWith("custom:")) {
      const port = window.location.port;
      const subUrl = `http://127.0.0.1:${port}${sub.value.replace("custom:", "")}`;
      mpvLoadExternalSubtitle(subUrl, sub.label);
      appliedSub.current = true;
    } else {
      // Embedded subtitle: use existing track selection
      mpvSetSubtitleTrack(idx);
      appliedSub.current = true;
    }
  }, [activeSub, subs, infoHash]);

  const { introRange, showSkipIntro, handleSkipIntro } = useIntro({
    infoHash: infoHash!, fileIndex: fileIndex!, introRangeRef, getEffectiveTime, seekTo, location, mediaTitle,
  });

  // Sync episode metadata to PlayerContext for RC state broadcast
  useEffect(() => {
    if (state?.type === "tv" && state?.season != null && state?.episode != null) {
      episodeInfoRef.current = {
        mediaType: "tv",
        season: Number(state.season),
        episode: Number(state.episode),
        seasonEpisodeCount: state.seasonEpisodeCount != null ? Number(state.seasonEpisodeCount) : 0,
        tmdbId: state.tmdbId ?? undefined,
        imdbId: state.imdbId ?? undefined,
        seasonCount: state.seasonCount != null ? Number(state.seasonCount) : undefined,
        posterPath: state.posterPath ?? undefined,
      };
    } else {
      episodeInfoRef.current = state?.type ? { mediaType: state.type, season: 0, episode: 0, seasonEpisodeCount: 0, tmdbId: state.tmdbId ?? undefined, imdbId: state.imdbId ?? undefined, posterPath: state.posterPath ?? undefined } : null;
    }
    return () => { episodeInfoRef.current = null; };
  }, [state, episodeInfoRef]);

  // ── Next episode (triggered by phone remote) ──
  const handleNextEpisode = useCallback(async (nextSeason: number, nextEpisode: number) => {
    if (!state?.tmdbId) return;
    beaconProgressRef.current();
    const title = state.baseName || mediaTitle;
    const year = state.year != null ? Number(state.year) : undefined;
    const imdbId = state.imdbId ?? undefined;
    await waitForBridge();
    if (state.posterPath) mpvSetPoster(`https://image.tmdb.org/t/p/w1280${state.posterPath}`);
    mpvSetTitle(`${title} — S${nextSeason}E${nextEpisode}`);
    mpvSetLoadingStatus("Finding best stream...");
    mpvSetLoading(true);
    try {
      const [result, seasonData] = await Promise.all([
        autoPlay(title, year, "tv", nextSeason, nextEpisode, imdbId),
        fetchSeason(state.tmdbId, nextSeason).catch(() => null),
      ]);
      const seasonEpisodeCount = seasonData?.episodes?.length ?? undefined;
      const episodeTitle = seasonData?.episodes?.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ep: any) => ep.episode_number === nextEpisode
      )?.name;
      navigate("/", { replace: true });
      await mpvStopAndWait();
      startStream(result.infoHash, result.fileIndex, `${title} — S${nextSeason}E${nextEpisode}`, result.tags || [], result.debridStreamKey);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const navState: any = {
        tags: result.tags, title: `${title} — S${nextSeason}E${nextEpisode}`, baseName: title,
        tmdbId: state.tmdbId, year, type: "tv", imdbId, posterPath: state.posterPath ?? null,
        season: nextSeason, episode: nextEpisode,
        episodeTitle, seasonEpisodeCount,
        seasonCount: state.seasonCount != null ? Number(state.seasonCount) : undefined,
      };
      if (result.debridStreamKey) navState.debridStreamKey = result.debridStreamKey;
      navigate(`/play/${result.infoHash}/${result.fileIndex}`, { state: navState });
    } catch {
      mpvSetLoading(false);
    }
  }, [state, mediaTitle, navigate, startStream]);

  // Detect stuck/slow source — show warning after 15s of 0 speed while incomplete
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(stuckTimer.current);
    if (dlProgress >= 1 || dlSpeed > 0 || !active) {
      mpvSetSlowWarning(false, false);
      return;
    }
    // Start timer when speed is 0 and download isn't complete
    stuckTimer.current = setTimeout(() => mpvSetSlowWarning(true, sources.length > 1), 15000);
    return () => clearTimeout(stuckTimer.current);
  }, [dlSpeed, dlProgress, active, sources.length]);

  // Forward loading status to QML overlay
  useEffect(() => {
    const isDebrid = !!state?.debridStreamKey;
    let status: string;
    if (isDebrid) {
      status = "Loading stream...";
    } else if (numPeers === 0 && dlProgress < 1) {
      status = "Connecting to peers...";
    } else if (dlProgress < 1) {
      const speed = dlSpeed >= 1048576
        ? `${(dlSpeed / 1048576).toFixed(1)} MB/s`
        : dlSpeed >= 1024
          ? `${(dlSpeed / 1024).toFixed(0)} KB/s`
          : `${dlSpeed} B/s`;
      status = `Connected to ${numPeers} peer${numPeers !== 1 ? "s" : ""} \u00b7 ${speed}`;
    } else {
      status = "Starting playback...";
    }
    mpvSetLoadingStatus(status);
  }, [numPeers, dlSpeed, dlProgress, state?.debridStreamKey]);

  // Sync PlayerContext.active with URL params (Detail.tsx navigates here without calling startStream)
  useEffect(() => {
    if (!infoHash || !fileIndex) return;
    if (active?.infoHash !== infoHash || String(active?.fileIndex) !== String(fileIndex)) {
      startStream(infoHash, fileIndex, mediaTitle, tags, state?.debridStreamKey);
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
      const debridStreamKey = state?.debridStreamKey;
      const streamUrl = debridStreamKey
        ? `http://127.0.0.1:${port}/api/debrid-stream?streamKey=${encodeURIComponent(debridStreamKey)}`
        : `http://127.0.0.1:${port}/api/stream/${infoHash}/${fileIndex}`;
      // Register event handlers BEFORE mpvPlay so the initial pauseChanged(false)
      // event isn't lost (it fires as soon as mpv processes the play command).
      let playbackStarted = false;
      let positionRestored = false;
      onMpvTimeChanged((t) => {
        const prev = effectiveTimeRef.current;
        effectiveTimeRef.current = { time: t, duration: prev?.duration ?? 0, ts: Date.now() };
        playbackStarted = true;
      });
      onMpvDurationChanged((d) => {
        const prev = effectiveTimeRef.current;
        effectiveTimeRef.current = { time: prev?.time ?? 0, duration: d, ts: Date.now() };
        // Restore saved playback position once we know the duration
        // sessionStorage (updated every 3s) is freshest within a session;
        // resumePosition from watch history persists across app restarts
        if (!positionRestored && d > 0) {
          positionRestored = true;
          const sessionPos = parseFloat(sessionStorage.getItem(playbackKey(infoHash!, fileIndex!)) || "0");
          const historyPos = state?.resumePosition ? parseFloat(state.resumePosition) : 0;
          const saved = sessionPos > 0 ? sessionPos : historyPos;
          if (shouldRestorePosition(saved, d)) {
            mpvSeek(saved);
          }
        }
      });
      onMpvEofReached(() => {
        if (playbackStarted) {
          goBack();
        }
      });
      onMpvPauseChanged((paused) => {
        setPlaying(!paused);
        if (paused) reportProgressRef.current();
      });

      console.log("[native-bridge] mpvPlay:", streamUrl);
      try {
        // Set poster for loading overlay before starting playback
        const posterPath = state?.posterPath;
        if (posterPath) {
          mpvSetPoster(`https://image.tmdb.org/t/p/w1280${posterPath}`);
        }
        mpvSetTitle(mediaTitle || "");
        mpvPlay(streamUrl);
        console.log("[native-bridge] mpvPlay sent");
      } catch (e) {
        console.error("[native-bridge] mpvPlay error:", e);
      }
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
        // Map mpv 1-based audio ID back to the streamIndex used by our track array.
        // mpv audio IDs are sequential (1, 2, 3…) matching our audioTracksRef order.
        const track = audioTracksRef.current[mpvId - 1];
        activeAudioRef.current = track ? track.value : mpvId;
      });
      onNativeSubSizeChanged((size) => {
        setSubSizeAbsolute(size);
      });
      onNativeSubDelayChanged((delay) => {
        subDelayRef.current = delay;
      });
      onBackRequested(() => {
        goBackRef.current();
      });
      onToggleSourcePanel(() => {
        setShowSources((v) => !v);
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
        window.mpvEvents.onNativeSubSizeChanged = null;
        window.mpvEvents.onNativeSubDelayChanged = null;
        window.mpvEvents.onBackRequested = null;
        window.mpvEvents.onToggleSourcePanel = null;
      }
      // Don't call mpvStop() here — mpv handles loadfile transitions natively.
      // Stopping tears down the video surface and causes black screen on next play.
    };
  }, [infoHash, fileIndex]);

  // QML FileDialog calls this after user picks a subtitle file and mpv loads it
  useEffect(() => {
    (window as any).__rattinCustomSubLoaded = (fileName: string) => {
      const label = fileName || "Custom subtitle";
      const customValue = `custom:local:${fileName}`;
      subsRef.current = [{ value: customValue, label: label + " (custom)" }, ...subsRef.current.filter(s => s.value !== customValue)];
      activeSubRef.current = customValue;
    };
    return () => { delete (window as any).__rattinCustomSubLoaded; };
  }, []);

  // Stop mpv on unmount (leaving the player page). The native mpv overlay
  // covers the WebEngine view, so it must be fully stopped to show the UI.
  useEffect(() => {
    return () => { mpvStop(); };
  }, []);

  // Heartbeat: keep the server's idle tracker alive while on the Player page.
  // useSeek polls /api/status every 1.5s which normally suffices, but Chromium
  // may throttle timers when the window is backgrounded. A 30s ping with
  // keepalive ensures the server never considers us idle.
  useEffect(() => {
    const timer = setInterval(() => {
      fetch("/api/heartbeat", { keepalive: true }).catch(() => {});
    }, 30000);
    return () => clearInterval(timer);
  }, []);

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
        // Use subsRef (always current) instead of subs (render closure, can be stale)
        const currentSubs = subsRef.current;
        const idx = currentSubs.findIndex(s => s.value === val);
        if (idx < 0) return;
        const sub = currentSubs[idx];
        if (sub.value.startsWith("file:")) {
          const port = window.location.port;
          const subUrl = `http://127.0.0.1:${port}/api/subtitle/${infoHash}/${sub.fileIndex}`;
          mpvLoadExternalSubtitle(subUrl, sub.label);
        } else if (sub.value.startsWith("custom:")) {
          const port = window.location.port;
          const subUrl = `http://127.0.0.1:${port}${sub.value.replace("custom:", "")}`;
          mpvLoadExternalSubtitle(subUrl, sub.label);
        } else {
          mpvSetSubtitleTrack(idx);
        }
        activeSubRef.current = val;
      },
      switchAudio: (streamIndex: string | number) => {
        const idx = audioTracks.findIndex(t => t.value === Number(streamIndex));
        if (idx >= 0) mpvSetAudioTrack(idx);
        activeAudioRef.current = typeof streamIndex === "string" ? parseInt(streamIndex, 10) : streamIndex;
      },
      switchSource: handleSwitchSource,
      nextEpisode: handleNextEpisode,
    };
  }
  useEffect(() => {
    return () => { if (commandRef) commandRef.current = null; };
  }, []);

  // ── Watch history progress reporting (periodic + on pause/unmount) ──
  const reportProgressRef = useRef(() => {});
  reportProgressRef.current = () => {
    const time = effectiveTimeRef.current;
    if (!time || !state?.tmdbId) return;
    const tmdbId = Number(state.tmdbId);
    if (isNaN(tmdbId)) return;
    const pos = Math.floor(time.time);
    const dur = Math.floor(time.duration);
    if (pos < 10) return; // don't overwrite good history with near-zero on initial load
    reportWatchProgress({
      tmdbId,
      mediaType: state.type || "movie",
      title: state.baseName || mediaTitle,
      baseName: state.baseName || mediaTitle,
      posterPath: state.posterPath ?? null,
      season: state.season != null ? Number(state.season) : undefined,
      episode: state.episode != null ? Number(state.episode) : undefined,
      episodeTitle: state.episodeTitle ?? undefined,
      seasonEpisodeCount: state.seasonEpisodeCount != null ? Number(state.seasonEpisodeCount) : undefined,
      seasonCount: state.seasonCount != null ? Number(state.seasonCount) : undefined,
      position: pos,
      duration: dur,
      imdbId: state.imdbId ?? undefined,
      year: state.year != null ? Number(state.year) : undefined,
    }).catch(() => {});
  };

  // Save progress on unmount — sync XHR guarantees delivery during unmount
  const savedOnExit = useRef(false);
  const beaconProgressRef = useRef(() => {});
  beaconProgressRef.current = () => {
    if (savedOnExit.current) return;
    const time = effectiveTimeRef.current;
    if (!time || !state?.tmdbId) return;
    const tmdbId = Number(state.tmdbId);
    if (isNaN(tmdbId)) return;
    const pos = Math.floor(time.time);
    if (pos < 10) return; // don't overwrite good history with near-zero on initial load
    const payload = JSON.stringify({
      tmdbId,
      mediaType: state.type || "movie",
      title: state.baseName || mediaTitle,
      baseName: state.baseName || mediaTitle,
      posterPath: state.posterPath ?? null,
      season: state.season != null ? Number(state.season) : undefined,
      episode: state.episode != null ? Number(state.episode) : undefined,
      episodeTitle: state.episodeTitle ?? undefined,
      seasonEpisodeCount: state.seasonEpisodeCount != null ? Number(state.seasonEpisodeCount) : undefined,
      seasonCount: state.seasonCount != null ? Number(state.seasonCount) : undefined,
      position: pos,
      duration: Math.floor(time.duration),
      imdbId: state.imdbId ?? undefined,
      year: state.year != null ? Number(state.year) : undefined,
    });
    // Synchronous XHR blocks until complete — guarantees delivery during unmount
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/watch-history/progress", false);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(payload);
    } catch { /* best effort */ }
    savedOnExit.current = true;
  };

  // Save progress, stop mpv, then navigate back
  const goBack = useCallback(() => {
    beaconProgressRef.current();
    mpvStop();
    navigate(-1);
  }, [navigate]);
  // Stable ref for use inside bridge callbacks (avoids stale closure)
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;

  // Set window.__rattinWatchState immediately so QML can save progress before bridge.stop()
  // Metadata set eagerly; position/duration are filled by QML from its own properties
  useEffect(() => {
    if (!state?.tmdbId) return;
    const tmdbId = Number(state.tmdbId);
    if (isNaN(tmdbId)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__rattinWatchState = {
      tmdbId,
      mediaType: state.type || "movie",
      title: state.baseName || mediaTitle,
      baseName: state.baseName || mediaTitle,
      posterPath: state.posterPath ?? null,
      season: state.season != null ? Number(state.season) : undefined,
      episode: state.episode != null ? Number(state.episode) : undefined,
      episodeTitle: state.episodeTitle ?? undefined,
      seasonEpisodeCount: state.seasonEpisodeCount != null ? Number(state.seasonEpisodeCount) : undefined,
      seasonCount: state.seasonCount != null ? Number(state.seasonCount) : undefined,
      position: 0,
      duration: 0,
      imdbId: state.imdbId ?? undefined,
      year: state.year != null ? Number(state.year) : undefined,
    };
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__rattinWatchState = null;
    };
  }, [state, mediaTitle]);

  // Periodic reporting every 30s
  useEffect(() => {
    const interval = setInterval(() => reportProgressRef.current(), 30_000);
    return () => clearInterval(interval);
  }, []);

  // Report on unmount (leaving player)
  useEffect(() => {
    return () => { beaconProgressRef.current(); };
  }, []);

  // Keyboard and playback controls are handled by the native QML overlay

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
      if (rcSessionId && rcAuthToken) {
        try {
          const res = await fetch(`/api/rc/session/${rcSessionId}?token=${encodeURIComponent(rcAuthToken)}`);
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
  }, [rcAuthToken, rcRemoteConnected, rcSessionId, setRcAuthToken, setRcSessionId]);

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
    <div className="player-page" ref={pageRef}>

      {remoteToast && (
        <div className={`player-remote-toast ${remoteToast}`} key={remoteToast}>
          <span className="player-remote-toast-dot" />
          {remoteToast === "connected" ? "Remote connected" : "Remote disconnected"}
        </div>
      )}

      {/* Loading/buffering/slow source UI is handled by QML overlays */}

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

      {/* Playback controls are handled by the native QML overlay (main.qml) */}

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
                        {s.cached && <span className="player-source-tag cached">Cached</span>}
                        {s.seasonPack && <span className="player-source-tag season-pack">Season Pack</span>}
                        {s.tags?.filter((t: string) => t !== "Native").map((t: string) => (
                          <span key={t} className="player-source-tag">{t}</span>
                        ))}
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
