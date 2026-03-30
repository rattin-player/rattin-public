import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { usePlayer } from "../lib/PlayerContext";
import { usePlayerLoading } from "../lib/usePlayerLoading";
import { fetchStatus, fetchDuration, fetchSubtitleTracks, fetchAudioTracks } from "../lib/api";
import { useIntro } from "../lib/useIntro";
import { formatTime, formatBytes } from "../lib/utils";
import { encode } from "uqr";
import "./Player.css";

const LANG_MAP = {
  eng: "English", en: "English", spa: "Spanish", es: "Spanish",
  fre: "French", fr: "French", ger: "German", de: "German",
  por: "Portuguese", pt: "Portuguese", ita: "Italian", it: "Italian",
  jpn: "Japanese", ja: "Japanese", kor: "Korean", ko: "Korean",
  chi: "Chinese", zh: "Chinese", ara: "Arabic", ar: "Arabic",
  rus: "Russian", ru: "Russian", dut: "Dutch", nl: "Dutch",
  pol: "Polish", pl: "Polish", tur: "Turkish", tr: "Turkish",
};

export default function Player() {
  const { infoHash, fileIndex } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { videoRef, startStream, active, effectiveTimeRef, subsRef, activeSubRef, audioTracksRef, activeAudioRef, commandRef, dlProgressRef, dlSpeedRef, dlPeersRef, rcSessionId, rcAuthToken, rcRemoteConnected, rcQrRequested, setRcSessionId, setRcAuthToken, introRangeRef, volume } = usePlayer();
  const tags = location.state?.tags || active?.tags || [];
  const mediaTitle = location.state?.title || active?.title || "";
  const preSelectedAudio = location.state?.audioTrack ?? null;
  const preSelectedSub = location.state?.subtitle ?? null;
  const videoContainerRef = useRef();
  const pageRef = useRef();
  const seekRef = useRef();
  const hideTimer = useRef();
  const pollRef = useRef();
  const [showControls, setShowControls] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [knownDuration, setKnownDuration] = useState(0);
  const [dlProgress, setDlProgress] = useState(0);
  const [dlSpeed, setDlSpeed] = useState(0);
  const [numPeers, setNumPeers] = useState(0);
  const [isLiveTranscode, setIsLiveTranscode] = useState(false);
  const [seekOffset, setSeekOffset] = useState(() => {
    try {
      const src = videoRef.current?.src;
      if (src) return parseFloat(new URL(src).searchParams.get("t")) || 0;
    } catch {}
    return 0;
  });
  const [transcodeReady, setTranscodeReady] = useState(false);
  const [subs, setSubsRaw] = useState(subsRef.current || []);
  const [activeSub, setActiveSubRaw] = useState(activeSubRef.current || "");

  function setSubs(val) {
    setSubsRaw((prev) => {
      const next = typeof val === "function" ? val(prev) : val;
      subsRef.current = next;
      return next;
    });
  }

  function setActiveSub(val) {
    setActiveSubRaw(val);
    activeSubRef.current = val;
  }
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
  const [fileName, setFileName] = useState("");
  const [tooltipTime, setTooltipTime] = useState(null);
  const [tooltipX, setTooltipX] = useState(0);
  const {
    loading, setLoading, loadingReason, setLoadingReason,
    loadingMsg, currentMessage, pendingSubReload, MESSAGES,
  } = usePlayerLoading(videoRef, { infoHash, fileIndex, reloadActiveSub });
  const seekOffsetRef = useRef(0);
  const isLiveRef = useRef(false);
  const transcodeReadyRef = useRef(false);
  const knownDurRef = useRef(0);

  useEffect(() => { seekOffsetRef.current = seekOffset; }, [seekOffset]);
  useEffect(() => { isLiveRef.current = isLiveTranscode; }, [isLiveTranscode]);
  useEffect(() => { transcodeReadyRef.current = transcodeReady; }, [transcodeReady]);
  useEffect(() => { knownDurRef.current = knownDuration; }, [knownDuration]);

  const getEffectiveTime = useCallback(() => {
    const v = videoRef.current;
    if (!v) return 0;
    return isLiveRef.current ? seekOffsetRef.current + (v.currentTime || 0) : v.currentTime || 0;
  }, []);

  const getEffectiveDuration = useCallback(() => {
    const v = videoRef.current;
    if (knownDurRef.current > 0) return knownDurRef.current;
    if (v?.duration && isFinite(v.duration)) {
      return isLiveRef.current ? seekOffsetRef.current + v.duration : v.duration;
    }
    return 0;
  }, []);

  // seekTo is defined below but only used by handleSkipIntro (user-triggered callback)
  const { introRange, showSkipIntro, handleSkipIntro } = useIntro(videoRef, {
    infoHash, fileIndex, introRangeRef, getEffectiveTime, seekTo, location, mediaTitle,
  });

  // Move video element into the fullscreen container
  useEffect(() => {
    const v = videoRef.current;
    const container = videoContainerRef.current;
    if (!v || !container) return;
    v.style.display = "";
    container.appendChild(v);
    return () => {
      // Don't hide — mini player will pick it up
    };
  }, []);

  // Start or resume stream
  useEffect(() => {
    startStream(infoHash, fileIndex, mediaTitle, tags);
    fetchDurationRetry(infoHash, fileIndex);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [infoHash, fileIndex]);

  // Register command handlers for remote control (assigned every render to avoid stale closures)
  if (commandRef) {
    commandRef.current = {
      seek: seekTo,
      seekRelative: (delta) => seekTo(Math.max(0, getEffectiveTime() + delta)),
      switchSubtitle,
      switchAudio,
    };
  }
  useEffect(() => {
    return () => { if (commandRef) commandRef.current = null; };
  }, []);

  async function fetchDurationRetry(ih, fi, retries = 5) {
    try {
      const data = await fetchDuration(ih, fi);
      if (data.duration) { setKnownDuration(data.duration); return; }
    } catch {}
    if (retries > 0) setTimeout(() => fetchDurationRetry(ih, fi, retries - 1), 5000);
  }

  // Status polling
  useEffect(() => {
    async function poll() {
      try {
        const data = await fetchStatus(infoHash);
        if (!data.files) return;
        setDlSpeed(data.downloadSpeed || 0);
        setNumPeers(data.numPeers || 0);
        dlSpeedRef.current = data.downloadSpeed || 0;
        dlPeersRef.current = data.numPeers || 0;
        const file = data.files.find((f) => f.index === Number(fileIndex));
        if (file) {
          setDlProgress(file.progress || 0);
          dlProgressRef.current = file.progress || 0;
          setFileName(file.name || "");
          // Pick up duration from status poll (may arrive before /api/duration)
          if (file.duration && file.duration > 0 && knownDurRef.current === 0) {
            setKnownDuration(file.duration);
          }
          const ext = (file.name || "").split(".").pop().toLowerCase();
          const needsXcode = !["mp4", "m4v", "webm"].includes(ext);
          if (needsXcode && !transcodeReadyRef.current) {
            setIsLiveTranscode(true);
          }
          if (file.transcodeStatus === "ready" && !transcodeReadyRef.current) {
            setTranscodeReady(true);
            switchToTranscoded();
          }
        }
      } catch {}
    }
    poll();
    pollRef.current = setInterval(poll, 1500);
    return () => clearInterval(pollRef.current);
  }, [infoHash, fileIndex]);

  function switchToTranscoded() {
    const v = videoRef.current;
    if (!v) return;
    // Defer if currently seeking — wait for the seek to land first
    if (loading && loadingReason === "seeking") {
      v.addEventListener("canplay", function onReady() {
        v.removeEventListener("canplay", onReady);
        switchToTranscoded();
      }, { once: true });
      return;
    }
    const pos = getEffectiveTime();
    setLoading(true);
    setLoadingReason("initial");
    setIsLiveTranscode(false);
    setSeekOffset(0);
    v.src = `/api/stream/${infoHash}/${fileIndex}`;
    v.addEventListener("loadedmetadata", function onMeta() {
      v.removeEventListener("loadedmetadata", onMeta);
      v.currentTime = pos;
      v.play().catch(() => {});
    });
  }

  // Subtitle loading
  useEffect(() => {
    loadSubs();
    const timer = setInterval(loadSubs, 5000);
    return () => clearInterval(timer);

    async function loadSubs() {
      try {
        const data = await fetchSubtitleTracks(infoHash, fileIndex);
        if (data.tracks?.length > 0) {
          setSubs((prev) => {
            if (prev.length === data.tracks.length) return prev;
            return data.tracks.map((t) => ({
              value: `embedded:${t.streamIndex}`,
              label: (t.title || LANG_MAP[t.lang] || t.lang || `Track ${t.streamIndex}`) + " (embedded)",
              streamIndex: t.streamIndex,
            }));
          });
          // Auto-select pre-selected subtitle from navigation state
          if (preSelectedSub && !activeSubRef.current) {
            const match = data.tracks.find((t) => `embedded:${t.streamIndex}` === preSelectedSub);
            if (match) {
              setTimeout(() => switchSubtitle(preSelectedSub), 500);
            }
          }
          clearInterval(timer);
        }
      } catch {}
    }
  }, [infoHash, fileIndex]);

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

  useEffect(() => {
    fetchStatus(infoHash).then((data) => {
      if (!data.files) return;
      const subFiles = data.files.filter((f) => f.isSubtitle);
      if (subFiles.length > 0) {
        setSubs((prev) => {
          const external = subFiles.map((f) => ({
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

  function guessLabel(name) {
    const base = name.replace(/\.[^.]+$/, "").toLowerCase();
    for (const [code, lang] of Object.entries(LANG_MAP)) {
      if (base.includes("." + code) || base.includes("_" + code) || base.includes("-" + code)) return lang;
    }
    return name.replace(/\.[^.]+$/, "").split(/[/\\]/).pop();
  }

  function clearAllTracks() {
    const v = videoRef.current;
    if (!v) return;
    for (const t of v.textTracks) t.mode = "disabled";
    v.querySelectorAll("track").forEach((el) => el.remove());
  }

  // Shift VTT cue timestamps and remove cues before the offset
  function shiftVtt(vttText, offsetSeconds) {
    if (!offsetSeconds || offsetSeconds <= 0) return vttText;

    // Parse timestamp — supports both HH:MM:SS.mmm and MM:SS.mmm
    function parseTs(ts) {
      const full = ts.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
      if (full) return parseInt(full[1]) * 3600 + parseInt(full[2]) * 60 + parseInt(full[3]) + parseInt(full[4]) / 1000;
      const short = ts.match(/(\d{2}):(\d{2})\.(\d{3})/);
      if (short) return parseInt(short[1]) * 60 + parseInt(short[2]) + parseInt(short[3]) / 1000;
      return -1;
    }

    function fmtTs(t) {
      const hh = Math.floor(t / 3600);
      const mm = Math.floor((t % 3600) / 60);
      const ss = Math.floor(t % 60);
      const ms = Math.round((t % 1) * 1000);
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
    }

    const lines = vttText.split("\n");
    const out = [];
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

  function loadSubtitleTrack(src, timeOffset) {
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

  function switchSubtitle(val) {
    setActiveSub(val);
    if (!videoRef.current) return;
    if (!val) { clearAllTracks(); return; }
    reloadActiveSub(isLiveRef.current ? seekOffsetRef.current : 0);
  }

  function switchAudio(streamIndex) {
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
  }

  // Time update — sync to local state AND push to context for mini player
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    function onTime() {
      const t = getEffectiveTime();
      const d = getEffectiveDuration();
      setCurrentTime(t);
      setDuration(d);
      setPlaying(!v.paused);
      effectiveTimeRef.current = { time: t, duration: d, ts: Date.now() };
    }
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onTime);
    v.addEventListener("pause", onTime);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onTime);
      v.removeEventListener("pause", onTime);
    };
  }, [getEffectiveTime, getEffectiveDuration]);

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

  function handlePageClick(e) {
    // If clicking the video area (not a control), toggle play and show controls
    const tag = e.target.tagName;
    if (tag === "BUTTON" || tag === "SELECT" || tag === "OPTION" || tag === "SVG" || tag === "PATH") return;
    togglePlay();
    showControlsBriefly();
  }

  function togglePlay() {
    const v = videoRef.current;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  function reloadActiveSub(seekOffset) {
    const sub = activeSubRef.current;
    if (!sub) return;
    let src;
    if (sub.startsWith("file:")) {
      src = `/api/subtitle/${infoHash}/${parseInt(sub.split(":")[1], 10)}`;
    } else if (sub.startsWith("embedded:")) {
      src = `/api/subtitle-extract/${infoHash}/${fileIndex}/${parseInt(sub.split(":")[1], 10)}`;
    }
    if (src) loadSubtitleTrack(src, seekOffset || 0);
  }

  function seekTo(seconds) {
    const v = videoRef.current;
    if (isLiveRef.current) {
      const dur = getEffectiveDuration();
      // Clamp to duration but allow seeking anywhere — server fetches pieces on demand
      if (dur > 0 && seconds > dur) return;
      setSeekOffset(seconds);
      setIsLiveTranscode(true);
      setLoading(true);
      setLoadingReason("seeking");
      const audioParam = activeAudioRef.current !== null ? `&audio=${activeAudioRef.current}` : "";
      v.src = `/api/stream/${infoHash}/${fileIndex}?t=${seconds}${audioParam}`;
      v.play().catch(() => {});
      if (dur > 0) setKnownDuration(dur);
      // Defer subtitle reload — track must be added after new source loads
      pendingSubReload.current = seconds;
    } else {
      v.currentTime = seconds;
    }
  }

  function handleSeekClick(e) {
    const rect = seekRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = duration || getEffectiveDuration();
    if (dur > 0) seekTo(ratio * dur);
  }

  function handleSeekHover(e) {
    const rect = seekRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = duration || getEffectiveDuration();
    setTooltipTime(dur > 0 ? ratio * dur : null);
    setTooltipX(ratio * 100);
  }

  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      const v = videoRef.current;
      if (!v) return;
      switch (e.key) {
        case " ": e.preventDefault(); togglePlay(); break;
        case "ArrowLeft": seekTo(Math.max(0, getEffectiveTime() - 10)); break;
        case "ArrowRight": seekTo(getEffectiveTime() + 10); break;
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
  const [remoteToast, setRemoteToast] = useState(null);
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
  const reconnectQrSvg = useMemo(() => {
    if (!showReconnectQr) return null;
    const url = `${window.location.origin}/api/rc/auth?session=${rcSessionId}&token=${rcAuthToken}`;
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
  }, [showReconnectQr, rcSessionId, rcAuthToken]);

  return (
    <div className="player-page" ref={pageRef} onClick={handlePageClick}>
      <div className="player-video-container" ref={videoContainerRef} />

      {remoteToast && (
        <div className={`player-remote-toast ${remoteToast}`} key={remoteToast}>
          <span className="player-remote-toast-dot" />
          {remoteToast === "connected" ? "Remote connected" : "Remote disconnected"}
        </div>
      )}

      {loading && (
        <div className="player-loading">
          <button className="player-loading-back" onClick={() => navigate(-1)}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
            </svg>
          </button>
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

      <div className={`player-overlay ${showControls ? "visible" : ""}`}>
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
                {formatBytes(dlSpeed)}/s · {numPeers} peer{numPeers !== 1 ? "s" : ""} · {Math.round(dlProgress * 100)}%
              </span>
            )}
            <div className="player-spacer" />
            <div className="player-volume">
              <button className="player-volume-icon" onClick={() => { const v = videoRef.current; if (v) { v.muted = !v.muted; } }}>
                {videoRef.current?.muted || volume === 0 ? (
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
                value={videoRef.current?.muted ? 0 : volume}
                onChange={(e) => { const v = videoRef.current; if (v) { v.muted = false; v.volume = parseFloat(e.target.value); } }}
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
