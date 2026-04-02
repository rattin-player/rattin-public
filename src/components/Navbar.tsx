import { useState, useEffect } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { usePlayer, useRemoteMode } from "../lib/PlayerContext";
import PairRemoteModal from "./PairRemoteModal";
import SettingsModal from "./SettingsModal";
import { getVpnStatus, toggleVpn } from "../lib/api";
import "./Navbar.css";

export default function Navbar() {
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const [showPairing, setShowPairing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [vpn, setVpn] = useState<{ active: boolean; configured: boolean } | null>(null);
  const [vpnToggling, setVpnToggling] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { rcSessionId } = usePlayer();
  const { isRemote } = useRemoteMode();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (location.pathname === "/search") setQuery(params.get("q") || "");
  }, [location]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    let mounted = true;
    const poll = () => getVpnStatus().then((s) => mounted && setVpn(s)).catch(() => {});
    poll();
    const timer = setInterval(poll, 10000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);


  async function handleVpnToggle() {
    if (!vpn?.configured || vpnToggling) return;
    setVpnToggling(true);
    try {
      await toggleVpn(vpn.active ? "off" : "on");
      const start = Date.now();
      const check = async () => {
        if (Date.now() - start > 15000) { setVpnToggling(false); return; }
        try {
          const s = await getVpnStatus();
          setVpn(s);
          setVpnToggling(false);
        } catch {
          setTimeout(check, 1000);
        }
      };
      setTimeout(check, 2000);
    } catch {
      setVpnToggling(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim()) navigate(`/search?q=${encodeURIComponent(query.trim())}`);
  }

  return (
    <>
    <nav className={`navbar ${scrolled ? "scrolled" : ""} ${isRemote ? "navbar-remote" : ""}`}>
      <Link to="/" className="navbar-brand">
        <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
          <rect x="2" y="2" width="28" height="28" rx="6" stroke="var(--accent)" strokeWidth="1.5" />
          <text x="16" y="22" textAnchor="middle" fontFamily="Georgia,serif" fontSize="18" fontWeight="700" fill="var(--accent-bright)">R</text>
        </svg>
        <span>rattin</span>
      </Link>
      <form className="navbar-search" onSubmit={handleSubmit}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="var(--text-muted)">
          <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
        </svg>
        <input
          type="text"
          placeholder="Search movies & shows..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </form>
      {!isRemote && (
        <>
          {vpn?.configured && (
            <button
              className={`navbar-vpn-pill ${vpn.active ? "active" : ""} ${vpnToggling ? "toggling" : ""}`}
              onClick={handleVpnToggle}
              disabled={vpnToggling}
              title={vpnToggling ? "Connecting..." : vpn.active ? "VPN Protected" : "VPN Off"}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" />
              </svg>
              <span>{vpnToggling ? "..." : vpn.active ? "On" : "Off"}</span>
            </button>
          )}
          <div className="navbar-actions">
          <button className="navbar-pair-btn" onClick={() => setShowSettings(true)} title="Settings">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.6 3.6 0 0112 15.6z" />
            </svg>
            Settings
          </button>
          <button className="navbar-pair-btn" onClick={() => setShowPairing(true)}>
            {rcSessionId ? (
              <span className="navbar-pair-connected">
                <span className="navbar-pair-dot" />
                Remote
              </span>
            ) : (
              <>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M17 1H7c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2zm0 18H7V5h10v14z" />
                </svg>
                Pair
              </>
            )}
          </button>
          </div>
        </>
      )}
    </nav>
    {showPairing && <PairRemoteModal onClose={() => setShowPairing(false)} />}
    {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  );
}
