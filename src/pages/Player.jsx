import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { usePlayer } from "../lib/PlayerContext";
import { fetchStatus, fetchDuration, fetchSubtitleTracks } from "../lib/api";
import { formatTime } from "../lib/utils";
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
  const { videoRef, startStream, active, effectiveTimeRef, subsRef, activeSubRef, commandRef } = usePlayer();
  const tags = location.state?.tags || active?.tags || [];
  const mediaTitle = location.state?.title || active?.title || "";
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
  const [isLiveTranscode, setIsLiveTranscode] = useState(false);
  const [seekOffset, setSeekOffset] = useState(0);
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
  const [fileName, setFileName] = useState("");
  const [tooltipTime, setTooltipTime] = useState(null);
  const [tooltipX, setTooltipX] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMsg, setLoadingMsg] = useState(0);
  const [loadingReason, setLoadingReason] = useState("initial"); // "initial" | "seeking"

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

  const MESSAGES = {
    initial: [
      "Getting everything ready...",
      "Finding the best source...",
      "Connecting to peers...",
      "Almost there...",
      "Buffering the good stuff...",
      "Just a moment...",
      "Preparing your stream...",
      "Hang tight, nearly ready...",
      "Setting things up for you...",
    ],
    seeking: [
      "Skipping ahead...",
      "Jumping to that part...",
      "Rebuffering...",
      "Almost there...",
      "One sec...",
      "Loading from new position...",
    ],
  };

  // Rotate loading messages
  useEffect(() => {
    if (!loading) return;
    setLoadingMsg(0);
    const msgs = MESSAGES[loadingReason] || MESSAGES.initial;
    const interval = setInterval(() => {
      setLoadingMsg((prev) => (prev + 1) % msgs.length);
    }, 6000);
    return () => clearInterval(interval);
  }, [loading, loadingReason]);

  // Detect when video is ready to play
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    setLoading(true);
    setLoadingReason("initial");
    function onCanPlay() { setLoading(false); }
    function onWaiting() { setLoading(true); }
    function onPlaying() { setLoading(false); }
    v.addEventListener("canplay", onCanPlay);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("playing", onPlaying);
    // If already ready
    if (v.readyState >= 3) setLoading(false);
    return () => {
      v.removeEventListener("canplay", onCanPlay);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("playing", onPlaying);
    };
  }, [infoHash, fileIndex]);

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

  // Register command handlers for remote control
  useEffect(() => {
    if (commandRef) {
      commandRef.current = {
        seek: seekTo,
        seekRelative: (delta) => seekTo(Math.max(0, getEffectiveTime() + delta)),
        switchSubtitle,
      };
    }
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
        const file = data.files.find((f) => f.index === Number(fileIndex));
        if (file) {
          setDlProgress(file.progress || 0);
          setFileName(file.name || "");
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
    const pos = getEffectiveTime();
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

  function switchSubtitle(val) {
    setActiveSub(val);
    const v = videoRef.current;
    if (!v) return;
    for (const t of v.textTracks) t.mode = "hidden";
    if (!val) return;

    const offsetParam = isLiveRef.current && seekOffsetRef.current > 0 ? `?offset=${seekOffsetRef.current}` : "";
    let src, label, key;
    if (val.startsWith("file:")) {
      const idx = parseInt(val.split(":")[1], 10);
      src = `/api/subtitle/${infoHash}/${idx}${offsetParam}`;
      label = "External";
      key = val;
    } else if (val.startsWith("embedded:")) {
      const idx = parseInt(val.split(":")[1], 10);
      src = `/api/subtitle-extract/${infoHash}/${fileIndex}/${idx}${offsetParam}`;
      label = "Embedded";
      key = val;
    }
    if (!src) return;

    const existing = v.querySelector(`track[data-key="${key}"]`);
    if (existing) existing.remove();
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.src = src;
    track.label = label;
    track.dataset.key = key;
    track.default = true;
    v.appendChild(track);
    track.addEventListener("load", () => { if (track.track) track.track.mode = "showing"; });
    if (track.track) track.track.mode = "showing";
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

  function reloadActiveSub(newOffset) {
    if (!activeSub) return;
    const v = videoRef.current;
    if (!v) return;
    // Remove all existing tracks and re-add with the new offset
    for (const t of v.textTracks) t.mode = "hidden";
    const offsetParam = newOffset > 0 ? `?offset=${newOffset}` : "";
    let src, key;
    if (activeSub.startsWith("file:")) {
      const idx = parseInt(activeSub.split(":")[1], 10);
      src = `/api/subtitle/${infoHash}/${idx}${offsetParam}`;
      key = activeSub;
    } else if (activeSub.startsWith("embedded:")) {
      const idx = parseInt(activeSub.split(":")[1], 10);
      src = `/api/subtitle-extract/${infoHash}/${fileIndex}/${idx}${offsetParam}`;
      key = activeSub;
    }
    if (!src) return;
    const existing = v.querySelector(`track[data-key="${key}"]`);
    if (existing) existing.remove();
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.src = src;
    track.label = "Subtitles";
    track.dataset.key = key;
    track.default = true;
    v.appendChild(track);
    track.addEventListener("load", () => { if (track.track) track.track.mode = "showing"; });
  }

  function seekTo(seconds) {
    const v = videoRef.current;
    if (isLiveRef.current) {
      const dur = getEffectiveDuration();
      if (dur > 0 && dlProgress < 1) {
        const maxSeekable = dur * dlProgress;
        if (seconds > maxSeekable) return;
      }
      setSeekOffset(seconds);
      setIsLiveTranscode(true);
      setLoading(true);
      setLoadingReason("seeking");
      v.src = `/api/stream/${infoHash}/${fileIndex}?t=${seconds}`;
      v.play().catch(() => {});
      if (dur > 0) setKnownDuration(dur);
      // Reload subtitles with the new offset
      setTimeout(() => reloadActiveSub(seconds), 500);
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

  return (
    <div className="player-page" ref={pageRef} onClick={handlePageClick}>
      <div className="player-video-container" ref={videoContainerRef} />

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
              {(MESSAGES[loadingReason] || MESSAGES.initial)[loadingMsg % (MESSAGES[loadingReason] || MESSAGES.initial).length]}
            </p>
          </div>
        </div>
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
            <div className="player-spacer" />
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
    </div>
  );
}
