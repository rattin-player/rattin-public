import { useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { usePlayer } from "../lib/PlayerContext";
import { formatTime } from "../lib/utils";
import "./MiniPlayer.css";

export default function MiniPlayer() {
  const { active, playing, currentTime, duration, togglePlay, stopStream, videoRef } = usePlayer();
  const navigate = useNavigate();
  const location = useLocation();
  const containerRef = useRef();

  const isOnPlayerPage = location.pathname.startsWith("/play/");

  // Move the video element into the mini player container when visible
  useEffect(() => {
    const v = videoRef.current;
    const container = containerRef.current;
    if (!v || !container || !active || isOnPlayerPage) return;
    v.style.display = "";
    container.prepend(v);
    return () => {
      v.style.display = "none";
      // Move back to body to keep it alive
      document.body.prepend(v);
    };
  }, [active, isOnPlayerPage]);

  if (!active || isOnPlayerPage) return null;

  function goFullscreen() {
    navigate(`/play/${active.infoHash}/${active.fileIndex}`, {
      state: { tags: active.tags, title: active.title },
    });
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="mini-player">
      <div className="mini-player-video" ref={containerRef} onClick={goFullscreen} />
      <div className="mini-player-info">
        <span className="mini-player-title">{active.title || "Playing"}</span>
        <span className="mini-player-time">{formatTime(currentTime)} / {formatTime(duration)}</span>
        <div className="mini-player-progress">
          <div className="mini-player-progress-bar" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <div className="mini-player-controls">
        <button onClick={togglePlay} className="mini-player-btn">
          {playing ? (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>
        <button onClick={goFullscreen} className="mini-player-btn" title="Expand">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
          </svg>
        </button>
        <button onClick={stopStream} className="mini-player-btn" title="Close">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
