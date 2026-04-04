import { useState, useEffect, type ReactNode } from "react";
import { Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { PlayerProvider, useRemoteMode, usePlayer } from "./lib/PlayerContext";
import Navbar from "./components/Navbar";
import MiniPlayer from "./components/MiniPlayer";
import RemoteNowPlaying from "./components/RemoteNowPlaying";
import TmdbSetup from "./components/TmdbSetup";
import Home from "./pages/Home";
import Detail from "./pages/Detail";
import Player from "./pages/Player";
import Search from "./pages/Search";
import MyList from "./pages/MyList";
import Remote from "./pages/Remote";
import { getTmdbStatus } from "./lib/api";
import { setupExternalLinkInterceptor } from "./lib/external-links";
import { getRemoteSessionId } from "./lib/remote-session";

function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <Navbar />
      {children}
    </>
  );
}

function AppRoutes() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isRemote } = useRemoteMode();
  const { navigateRef, switching } = usePlayer();
  const isPlayer = location.pathname.startsWith("/play/");

  // Smooth scroll to top on route changes (JS fallback for Qt WebEngine)
  useEffect(() => {
    const start = document.documentElement.scrollTop || document.body.scrollTop;
    if (start === 0) return;
    const duration = 300;
    const startTime = performance.now();
    function step(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      window.scrollTo(0, start * (1 - ease));
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }, [location.pathname]);

  // Wire up navigate for remote command handling
  useEffect(() => {
    navigateRef.current = navigate;
    return () => { navigateRef.current = null; };
  }, [navigate, navigateRef]);
  const isRemotePage = location.pathname === "/remote";

  if (isPlayer) {
    return (
      <Routes>
        <Route path="/play/:infoHash/:fileIndex" element={<Player />} />
      </Routes>
    );
  }

  // Remote control page — no player, no mini-player
  if (isRemotePage) {
    return (
      <Routes>
        <Route path="/remote" element={<Remote />} />
      </Routes>
    );
  }

  return (
    <>
      {switching && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9999,
          background: "#000", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div className="player-loading-spinner" />
        </div>
      )}
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/movie/:id" element={<Detail />} />
          <Route path="/tv/:id" element={<Detail />} />
          <Route path="/search" element={<Search />} />
          <Route path="/my-list" element={<MyList />} />
        </Routes>
        {!isRemote && <MiniPlayer />}
        {isRemote && <RemoteNowPlaying />}
      </Layout>
    </>
  );
}

export default function App() {
  const [tmdbReady, setTmdbReady] = useState<boolean | null>(null);

  useEffect(() => {
    // Phone remote uses the desktop's TMDB key — skip the setup gate
    if (getRemoteSessionId()) { setTmdbReady(true); return; }
    getTmdbStatus().then((s) => setTmdbReady(s.configured)).catch(() => setTmdbReady(false));
  }, []);

  // Intercept external links so they open in the system browser
  // (Qt WebEngine ignores target="_blank" by default)
  useEffect(() => setupExternalLinkInterceptor(), []);

  // After first successful basic auth, set a 30-day cookie so the browser
  // doesn't prompt again. Fire-and-forget, runs once per page load.
  useEffect(() => {
    if (!document.cookie.includes("rc_auth=")) {
      fetch("/api/auth/persist").catch(() => {});
    }
  }, []);

  if (tmdbReady === null) return null; // loading
  if (!tmdbReady) return <TmdbSetup onComplete={() => setTmdbReady(true)} />;

  return (
    <PlayerProvider>
      <AppRoutes />
    </PlayerProvider>
  );
}
