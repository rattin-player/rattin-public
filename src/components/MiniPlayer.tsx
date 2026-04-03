import { useNavigate, useLocation } from "react-router-dom";
import { usePlayer } from "../lib/PlayerContext";
import { formatTime } from "../lib/utils";
import "./MiniPlayer.css";

export default function MiniPlayer() {
  const { active, currentTime, duration, stopStream } = usePlayer();
  const navigate = useNavigate();
  const location = useLocation();

  const isOnPlayerPage = location.pathname.startsWith("/play/");

  if (!active || isOnPlayerPage) return null;

  function resume() {
    navigate(`/play/${active!.infoHash}/${active!.fileIndex}`, {
      state: { tags: active!.tags, title: active!.title, debridStreamKey: active!.debridStreamKey },
    });
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="mini-player">
      <div className="mini-player-info">
        <span className="mini-player-title">{active.title || "Playing"}</span>
        <span className="mini-player-time">{formatTime(currentTime)} / {formatTime(duration)}</span>
        <div className="mini-player-progress">
          <div className="mini-player-progress-bar" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <div className="mini-player-controls">
        <button onClick={resume} className="mini-player-btn" title="Resume">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M8 5v14l11-7z" />
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
