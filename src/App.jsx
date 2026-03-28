import { Routes, Route, useLocation } from "react-router-dom";
import { PlayerProvider, useRemoteMode } from "./lib/PlayerContext";
import Navbar from "./components/Navbar";
import MiniPlayer from "./components/MiniPlayer";
import Home from "./pages/Home";
import Detail from "./pages/Detail";
import Player from "./pages/Player";
import Search from "./pages/Search";
import Remote from "./pages/Remote";

function Layout({ children }) {
  return (
    <>
      <Navbar />
      {children}
    </>
  );
}

function AppRoutes() {
  const location = useLocation();
  const { isRemote } = useRemoteMode();
  const isPlayer = location.pathname.startsWith("/play/");
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
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/movie/:id" element={<Detail />} />
        <Route path="/tv/:id" element={<Detail />} />
        <Route path="/search" element={<Search />} />
      </Routes>
      {!isRemote && <MiniPlayer />}
    </Layout>
  );
}

export default function App() {
  return (
    <PlayerProvider>
      <AppRoutes />
    </PlayerProvider>
  );
}
