import { useState, useEffect } from "react";
import { usePlayer } from "../lib/PlayerContext";
import "./PairRemoteModal.css";

export default function PairRemoteModal({ onClose }) {
  const { rcSessionId, setRcSessionId } = usePlayer();
  const [sessionId, setSessionId] = useState(rcSessionId);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (sessionId) {
      const url = `${window.location.origin}/remote?session=${sessionId}`;
      setRemoteUrl(url);
    }
  }, [sessionId]);

  async function createSession() {
    setCreating(true);
    try {
      const res = await fetch("/api/rc/session", { method: "POST" });
      const data = await res.json();
      setSessionId(data.sessionId);
      setRcSessionId(data.sessionId);
    } catch {
      // ignore
    }
    setCreating(false);
  }

  async function endSession() {
    if (sessionId) {
      await fetch(`/api/rc/session/${sessionId}`, { method: "DELETE" }).catch(() => {});
    }
    setSessionId(null);
    setRcSessionId(null);
    setRemoteUrl("");
  }

  function copyUrl() {
    navigator.clipboard.writeText(remoteUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  return (
    <div className="pair-overlay" onClick={onClose}>
      <div className="pair-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pair-header">
          <h3>Pair Remote</h3>
          <button className="pair-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        {!sessionId ? (
          <div className="pair-body">
            <p className="pair-desc">
              Use your phone as a remote control. Create a session and open the link on your phone.
            </p>
            <button className="pair-create-btn" onClick={createSession} disabled={creating}>
              {creating ? "Creating..." : "Create Session"}
            </button>
          </div>
        ) : (
          <div className="pair-body">
            <p className="pair-desc">
              Open this URL on your phone to connect as a remote:
            </p>
            <div className="pair-url-box">
              <code className="pair-url">{remoteUrl}</code>
              <button className="pair-copy-btn" onClick={copyUrl}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="pair-session-info">
              <span className="pair-session-id">Session: {sessionId}</span>
            </div>
            <button className="pair-end-btn" onClick={endSession}>
              End Session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
