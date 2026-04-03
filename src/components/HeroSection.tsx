import { memo } from "react";
import { useNavigate } from "react-router-dom";
import { backdrop } from "../lib/api";
import "./HeroSection.css";

interface HeroSectionProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any;
}

export default memo(function HeroSection({ item }: HeroSectionProps) {
  const navigate = useNavigate();
  if (!item) return <div className="hero skeleton" style={{ height: "70vh" }} />;

  const type = item.media_type || (item.first_air_date ? "tv" : "movie");
  const title = item.title || item.name;
  const bg = backdrop(item.backdrop_path);

  function handlePlay() {
    navigate(`/${type}/${item.id}`);
  }

  return (
    <div className="hero" style={{ backgroundImage: bg ? `url(${bg})` : "none" }}>
      <div className="hero-overlay" />
      <div className="hero-content">
        <h1 className="hero-title">{title}</h1>
        <p className="hero-overview">{item.overview}</p>
        <div className="hero-buttons">
          <button className="hero-btn play" onClick={handlePlay}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
            Play
          </button>
          <button className="hero-btn info" onClick={() => navigate(`/${type}/${item.id}`)}>
            More Info
          </button>
        </div>
      </div>
    </div>
  );
})
