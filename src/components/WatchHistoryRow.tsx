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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onRemove?: (item: any) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onPlay?: (item: any) => Promise<void>;
}

export default function WatchHistoryRow({ title, fetchFn, showProgress = false, onRemove, onPlay }: WatchHistoryRowProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [items, setItems] = useState<any[] | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
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

                const cardId = `${type}:${item.tmdbId}:${item.season ?? ""}:${item.episode ?? ""}`;
                return (
                  <div
                    key={cardId}
                    className={`movie-card wh-card${playingId === cardId ? " loading" : ""}`}
                    onClick={async () => {
                      if (onPlay) {
                        setPlayingId(cardId);
                        try {
                          await onPlay(item);
                        } catch {
                          navigate(`/${type}/${item.tmdbId}`);
                        } finally {
                          setPlayingId(null);
                        }
                      } else {
                        navigate(`/${type}/${item.tmdbId}`);
                      }
                    }}
                  >
                    <div className="movie-card-poster">
                      {img ? (
                        <img src={img} alt={item.title} loading="lazy" />
                      ) : (
                        <div className="movie-card-placeholder" />
                      )}
                      {onRemove && (
                        <button
                          className="wh-remove-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemove(item).then(() => {
                              setItems((prev) => prev ? prev.filter((i) =>
                                !(i.tmdbId === item.tmdbId && i.season === item.season && i.episode === item.episode)
                              ) : prev);
                            });
                          }}
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                          </svg>
                        </button>
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
