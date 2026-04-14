import { useState, useEffect, useMemo } from "react";
import { encode } from "uqr";
import { usePlayer } from "../lib/PlayerContext";
import { fetchLanIp } from "../lib/api";
import "./PairRemoteModal.css";

interface PairRemoteModalProps {
  onClose: () => void;
}

export default function PairRemoteModal({ onClose }: PairRemoteModalProps) {
  const { rcSessionId, setRcSessionId, rcAuthToken, setRcAuthToken, rcPairingCode, setRcPairingCode, rcRemoteConnected } = usePlayer();
  const [sessionId, setSessionId] = useState(rcSessionId);
  const [authToken, setAuthToken] = useState(rcAuthToken);
  const [pairingCode, setPairingCode] = useState(rcPairingCode);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [lanAddress, setLanAddress] = useState("");
  const [creating, setCreating] = useState(false);
  const [validating, setValidating] = useState(false);

  // On open, if we have a session, validate it's still alive on the server
  useEffect(() => {
    if (!sessionId || !authToken) return;
    setValidating(true);
    fetch(`/api/rc/session/${sessionId}?token=${encodeURIComponent(authToken)}`)
      .then((res) => {
        if (!res.ok) {
          // Session expired on server — clear it
          setSessionId(null);
          setAuthToken(null);
          setRcSessionId(null);
          setRcAuthToken(null);
        }
      })
      .catch(() => {})
      .finally(() => setValidating(false));
  }, [authToken, sessionId, setRcAuthToken, setRcSessionId]);

  useEffect(() => {
    if (!sessionId || !authToken) {
      setRemoteUrl("");
      return;
    }
    // QR must contain a LAN IP reachable by the phone
    fetchLanIp()
      .then(({ ip, port }) => {
        const origin = ip ? `http://${ip}:${port}` : window.location.origin;
        setRemoteUrl(`${origin}/api/rc/auth?session=${sessionId}&token=${authToken}`);
        setLanAddress(ip ? `${ip}:${port}` : new URL(window.location.origin).host);
      })
      .catch(() => {
        setRemoteUrl(`${window.location.origin}/api/rc/auth?session=${sessionId}&token=${authToken}`);
        setLanAddress(new URL(window.location.origin).host);
      });
  }, [sessionId, authToken]);

  async function createSession() {
    setCreating(true);
    try {
      const res = await fetch("/api/rc/session", { method: "POST" });
      const data = await res.json();
      setSessionId(data.sessionId);
      setAuthToken(data.authToken);
      setPairingCode(data.pairingCode);
      setRcSessionId(data.sessionId);
      setRcAuthToken(data.authToken);
      setRcPairingCode(data.pairingCode);
    } catch {
      // ignore
    }
    setCreating(false);
  }

  async function endSession() {
    if (sessionId && authToken) {
      await fetch(`/api/rc/session/${sessionId}?token=${encodeURIComponent(authToken)}`, { method: "DELETE" }).catch(() => {});
    }
    setSessionId(null);
    setAuthToken(null);
    setPairingCode(null);
    setRcSessionId(null);
    setRcAuthToken(null);
    setRcPairingCode(null);
    setRemoteUrl("");
  }

  const qrSvg = useMemo(() => {
    if (!remoteUrl) return null;
    const { data, size } = encode(remoteUrl, { ecc: "L" });
    const mod = 3;
    const margin = 4;
    const total = size * mod + margin * 2;
    let paths = "";
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (data[y][x])
          paths += `M${margin + x * mod},${margin + y * mod}h${mod}v${mod}h-${mod}z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"><rect width="${total}" height="${total}" fill="#fff" rx="4"/><path d="${paths}" fill="#000"/></svg>`;
  }, [remoteUrl]);

  const showQr = sessionId && authToken && !validating;

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

        {validating ? (
          <div className="pair-body">
            <p className="pair-desc">Checking session...</p>
          </div>
        ) : !showQr ? (
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
            {rcRemoteConnected ? (
              <div className="pair-status pair-status-connected">
                <span className="pair-status-dot" />
                Phone connected
              </div>
            ) : (
              <div className="pair-status pair-status-waiting">
                <span className="pair-status-dot" />
                Waiting for phone...
              </div>
            )}
            <p className="pair-desc">Scan with your phone or enter the code to connect:</p>
            {qrSvg && (
              <div className="pair-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
            )}
            {pairingCode && (
              <div className="pair-code-box">
                <span className="pair-code-label">
                  Or enter this code on your phone{lanAddress ? ` at ${lanAddress}` : ""}:
                </span>
                <span className="pair-code">{pairingCode}</span>
              </div>
            )}
            <button className="pair-end-btn" onClick={endSession}>
              End Session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
