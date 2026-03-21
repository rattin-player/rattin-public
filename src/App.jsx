import { Routes, Route, useLocation } from "react-router-dom";
import Navbar from "./components/Navbar";
import Home from "./pages/Home";
import Detail from "./pages/Detail";
import Player from "./pages/Player";
import Search from "./pages/Search";

function Layout({ children }) {
  return (
    <>
      <Navbar />
      {children}
    </>
  );
}

export default function App() {
  const location = useLocation();
  const isPlayer = location.pathname.startsWith("/play/");

  if (isPlayer) {
    return (
      <Routes>
        <Route path="/play/:infoHash/:fileIndex" element={<Player />} />
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
    </Layout>
  );
}
