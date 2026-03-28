import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { formatTime } from "../lib/utils";
import "./Remote.css";

export default function Remote() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const sessionId = searchParams.get("session") || localStorage.getItem("rc-session");

  const [connected, setConnected] = useState(false);
  const [state, setState] = useState(null);
  const [seekDragging, setSeekDragging] = useState(false);
  const [seekDragValue, setSeekDragValue] = useState(0);
  const seekBarRef = useRef(null);
  const esRef = useRef(null);

  // Persist session
  useEffect(() => {
    if (sessionId) localStorage.setItem("rc-session", sessionId);
  }, [sessionId]);

  // SSE connection
  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/rc/events?session=${sessionId}&role=remote`);
    esRef.current = es;

    es.addEventListener("state", (e) => {
      setState(JSON.parse(e.data));
    });
    es.addEventListener("connected", () => setConnected(true));
    es.addEventListener("disconnected", () => setConnected(false));
    es.onerror = () => {};

    return () => es.close();
  }, [sessionId]);

  const sendCommand = useCallback((action, value) => {
    if (!sessionId) return;
    fetch("/api/rc/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, action, value }),
    }).catch(() => {});
  }, [sessionId]);

  // Seek bar touch/mouse handling
  function getSeekRatio(e) {
    const rect = seekBarRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function onSeekStart(e) {
    e.preventDefault();
    setSeekDragging(true);
    const ratio = getSeekRatio(e);
    setSeekDragValue(ratio * (state?.duration || 0));
  }

  function onSeekMove(e) {
    if (!seekDragging) return;
    const ratio = getSeekRatio(e);
    setSeekDragValue(ratio * (state?.duration || 0));
  }

  function onSeekEnd() {
    if (!seekDragging) return;
    setSeekDragging(false);
    sendCommand("seek", seekDragValue);
  }

  // Attach global touch/mouse events for seek dragging
  useEffect(() => {
    if (!seekDragging) return;
    function move(e) { onSeekMove(e); }
    function end() { onSeekEnd(); }
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
  }, [seekDragging, seekDragValue, state?.duration]);

  if (!sessionId) {
    return (
      <div className="remote-page">
        <div className="remote-no-session">
          <p>No session found. Scan a QR code or open the remote link from your PC.</p>
          <button onClick={() => navigate("/")}>Go Home</button>
        </div>
      </div>
    );
  }

  const hasPlayback = state && state.infoHash;
  const ct = seekDragging ? seekDragValue : (state?.currentTime || 0);
  const dur = state?.duration || 0;
  const progress = dur > 0 ? (ct / dur) * 100 : 0;

  if (!hasPlayback) {
    return (
      <div className="remote-page">
        <div className="remote-waiting">
          <div className={`remote-status ${connected ? "online" : "offline"}`}>
            <span className="remote-status-dot" />
            {connected ? "Player connected" : "Player offline"}
          </div>
          <p className="remote-waiting-text">No active playback. Browse content to start playing.</p>
          <button className="remote-browse-btn" onClick={() => navigate(`/?session=${sessionId}`)}>
            Browse Content
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="remote-page">
      <div className={`remote-status ${connected ? "online" : "offline"}`}>
        <span className="remote-status-dot" />
        {connected ? "Connected" : "Player offline"}
      </div>

      <div className="remote-title-area">
        <h2 className="remote-title">{state.title || "Playing"}</h2>
        {state.tags?.length > 0 && (
          <div className="remote-tags">
            {state.tags.map((t) => <span key={t} className="remote-tag">{t}</span>)}
          </div>
        )}
      </div>

      <div className="remote-play-area">
        <button className="remote-play-btn" onClick={() => sendCommand("toggle-play")}>
          {state.playing ? (
            <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>
      </div>

      <div className="remote-seek-area">
        <span className="remote-time">{formatTime(ct)}</span>
        <div
          className="remote-seek-bar"
          ref={seekBarRef}
          onMouseDown={onSeekStart}
          onTouchStart={onSeekStart}
        >
          <div className="remote-seek-track">
            <div className="remote-seek-fill" style={{ width: `${progress}%` }} />
            <div className="remote-seek-thumb" style={{ left: `${progress}%` }} />
          </div>
        </div>
        <span className="remote-time">{formatTime(dur)}</span>
      </div>

      <div className="remote-skip-row">
        <button className="remote-skip-btn" onClick={() => sendCommand("seek-relative", -10)}>
          <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
            <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/>
          </svg>
          <span>10s</span>
        </button>
        <button className="remote-skip-btn" onClick={() => sendCommand("seek-relative", 10)}>
          <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
            <path d="M11.5 8c2.65 0 5.05.99 6.9 2.6L22 7v9h-9l3.62-3.62C15.23 11.22 13.46 10.5 11.5 10.5c-3.54 0-6.55 2.31-7.6 5.5L1.53 15.22C2.92 11.03 6.85 8 11.5 8z"/>
          </svg>
          <span>10s</span>
        </button>
      </div>

      <div className="remote-volume-row">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="var(--text-secondary)">
          <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
        </svg>
        <input
          type="range"
          className="remote-volume-slider"
          min="0"
          max="1"
          step="0.05"
          value={state.volume ?? 1}
          onChange={(e) => sendCommand("volume", parseFloat(e.target.value))}
        />
      </div>

      {state.subs?.length > 0 && (
        <div className="remote-sub-row">
          <select
            className="remote-sub-select"
            value={state.activeSub || ""}
            onChange={(e) => sendCommand("subtitle", e.target.value)}
          >
            <option value="">Subtitles Off</option>
            {state.subs.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
      )}

      <div className="remote-bottom-row">
        <button className="remote-browse-btn" onClick={() => navigate(`/?session=${sessionId}`)}>
          Browse
        </button>
        <button className="remote-stop-btn" onClick={() => sendCommand("stop-stream")}>
          Stop
        </button>
      </div>
    </div>
  );
}
