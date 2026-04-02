import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useRemoteMode } from "../lib/PlayerContext";
import { formatTime } from "../lib/utils";
import "../pages/Remote.css";

/**
 * Floating "Now Playing" bar shown on browse pages when the phone is in remote mode
 * and there's active playback on the PC. Gives the user a way to get back to controls.
 */
export default function RemoteNowPlaying() {
  const { isRemote, sessionId } = useRemoteMode();
  const location = useLocation();
  const navigate = useNavigate();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [state, setState] = useState<any>(null);
  const esRef = useRef<EventSource | null>(null);
  const lastGood = useRef({ currentTime: 0, duration: 0 });
  const failCount = useRef(0);

  const isOnRemotePage = location.pathname === "/remote";

  // Connect to SSE to get playback state
  useEffect(() => {
    if (!isRemote || !sessionId || isOnRemotePage) {
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      return;
    }

    const es = new EventSource(`/api/rc/events?session=${sessionId}&role=remote`);
    esRef.current = es;

    es.addEventListener("state", (e: MessageEvent) => {
      const parsed = JSON.parse(e.data);
      failCount.current = 0;
      if (parsed.duration > 0) lastGood.current.duration = parsed.duration;
      if (parsed.currentTime > 0) lastGood.current.currentTime = parsed.currentTime;
      setState(parsed);
    });

    es.onerror = () => {
      failCount.current++;
      // If too many failures, probe to check if session expired
      if (failCount.current > 5) {
        fetch(`/api/rc/session/${sessionId}`)
          .then((res) => {
            if (res.status === 404) {
              // Session expired — clear remote mode
              localStorage.removeItem("rc-session");
              localStorage.removeItem("rc-token");
              es.close();
              setState(null);
            }
          })
          .catch(() => {});
      }
    };

    return () => { es.close(); esRef.current = null; };
  }, [isRemote, sessionId, isOnRemotePage]);

  if (!isRemote || isOnRemotePage) return null;

  // Connected but no playback — show "Ready to stream" bar
  if (!state?.infoHash) {
    // Only show if we have a connection (state object exists means SSE is working)
    if (!state?.connected) return null;
    return (
      <div className="remote-now-playing remote-now-playing-idle">
        <div className="remote-now-playing-info">
          <div className="remote-now-playing-title">
            <span className="remote-idle-dot" />
            Connected
          </div>
          <div className="remote-now-playing-meta">Ready to stream</div>
        </div>
      </div>
    );
  }

  const ct = state.currentTime > 0 ? state.currentTime : lastGood.current.currentTime;
  const dur = state.duration > 0 ? state.duration : lastGood.current.duration;

  return (
    <div className="remote-now-playing" onClick={() => navigate(`/remote?session=${sessionId}`)}>
      <div className="remote-now-playing-info">
        <div className="remote-now-playing-title">{state.title || "Now Playing"}</div>
        <div className="remote-now-playing-meta">
          {state.playing ? "Playing" : "Paused"} &middot; {formatTime(ct)} / {formatTime(dur)}
        </div>
      </div>
      <button className="remote-now-playing-btn">Controls</button>
    </div>
  );
}
