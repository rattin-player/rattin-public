import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { poster } from "../lib/api";
import "./WatchHistoryRow.css";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface WatchHistoryRowProps {
  title: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchFn: () => Promise<{ items: any[] }>;
  showProgress?: boolean;
}

export default function WatchHistoryRow({ title, fetchFn, showProgress = false }: WatchHistoryRowProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [items, setItems] = useState<any[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    fetchFn()
      .then((data) => { if (!cancelled) setItems(data.items || []); })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, []);

  function scroll(dir: number) {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * 600, behavior: "smooth" });
  }

  if (items !== null && items.length === 0) return null;

  return (
    <div className="content-row">
      <h2 className="content-row-title">{title}</h2>
      <div className="content-row-wrapper">
        <button className="content-row-arrow left" onClick={() => scroll(-1)}>&lsaquo;</button>
        <div className="content-row-scroll" ref={scrollRef}>
          {items === null
            ? Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="movie-card">
                  <div className="movie-card-poster skeleton" />
                </div>
              ))
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            : items.map((item: any) => {
                const type = item.mediaType || "movie";
                const img = poster(item.posterPath);
                const pct = item.duration > 0 ? Math.min(100, (item.position / item.duration) * 100) : 0;
                const epLabel = type === "tv" && item.season != null
                  ? `S${item.season}E${item.episode}`
                  : null;

                return (
                  <div
                    key={`${type}:${item.tmdbId}:${item.season ?? ""}:${item.episode ?? ""}`}
                    className="movie-card"
                    onClick={() => navigate(`/${type}/${item.tmdbId}`)}
                  >
                    <div className="movie-card-poster">
                      {img ? (
                        <img src={img} alt={item.title} loading="lazy" />
                      ) : (
                        <div className="movie-card-placeholder" />
                      )}
                      {showProgress && pct > 0 && (
                        <div className="wh-progress-bar">
                          <div className="wh-progress-fill" style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </div>
                    <div className="movie-card-info">
                      <span className="movie-card-title">{item.title}</span>
                      {epLabel && <span className="movie-card-year">{epLabel}{item.episodeTitle ? ` — ${item.episodeTitle}` : ""}</span>}
                    </div>
                  </div>
                );
              })}
        </div>
        <button className="content-row-arrow right" onClick={() => scroll(1)}>&rsaquo;</button>
      </div>
    </div>
  );
}
