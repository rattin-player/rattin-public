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
          <button className="navbar-pair-btn" onClick={() => setShowSettings(true)} title="Debrid">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M20 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4V6h16v12zM4 0h16v2H4zm0 22h16v2H4zm8-10a2.5 2.5 0 000-5H9v5h3zm0-3.5c.55 0 1 .45 1 1s-.45 1-1 1h-1.5V9.5H12zm0 5.5H9v5h3a2.5 2.5 0 000-5zm0 3.5h-1.5V14H12c.55 0 1 .45 1 1s-.45 1-1 1z" />
            </svg>
            Debrid
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
