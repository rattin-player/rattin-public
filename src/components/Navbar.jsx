import { useState, useEffect } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { usePlayer, useRemoteMode } from "../lib/PlayerContext";
import PairRemoteModal from "./PairRemoteModal";
import "./Navbar.css";

export default function Navbar() {
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const [showPairing, setShowPairing] = useState(false);
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

  function handleSubmit(e) {
    e.preventDefault();
    if (query.trim()) navigate(`/search?q=${encodeURIComponent(query.trim())}`);
  }

  return (
    <nav className={`navbar ${scrolled ? "scrolled" : ""}`}>
      <Link to="/" className="navbar-brand">
        <svg viewBox="0 0 36 36" width="30" height="30" fill="none">
          <circle cx="12" cy="10" r="3" fill="var(--accent-bright)" />
          <circle cx="24" cy="10" r="3" fill="var(--accent-bright)" />
          <circle cx="12" cy="10" r="1.2" fill="var(--bg-deep)" />
          <circle cx="24" cy="10" r="1.2" fill="var(--bg-deep)" />
          <ellipse cx="18" cy="18" rx="10" ry="9" fill="var(--accent)" />
          <ellipse cx="18" cy="20" rx="5" ry="3.5" fill="var(--accent-bright)" />
          <circle cx="16" cy="19" r="0.8" fill="var(--bg-deep)" />
          <circle cx="20" cy="19" r="0.8" fill="var(--bg-deep)" />
          <ellipse cx="18" cy="22" rx="2" ry="1" fill="var(--bg-deep)" opacity="0.6" />
          <path d="M10 27 Q5 32 2 34" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        </svg>
        <span>rattin</span>
      </Link>
      <form className="navbar-search" onSubmit={handleSubmit}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="var(--text-muted)">
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
      )}
      {showPairing && <PairRemoteModal onClose={() => setShowPairing(false)} />}
    </nav>
  );
}
