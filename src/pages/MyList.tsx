import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { poster, fetchSavedList, toggleSaved } from "../lib/api";
import "./MyList.css";

interface SavedItem {
  tmdbId: number;
  mediaType: string;
  title: string;
  posterPath: string | null;
  season?: number;
  episode?: number;
  episodeTitle?: string;
}

export default function MyList() {
  const navigate = useNavigate();
  const [items, setItems] = useState<SavedItem[] | null>(null);

  function loadItems() {
    fetchSavedList()
      .then((data) => setItems(data.items || []))
      .catch(() => setItems([]));
  }

  useEffect(() => { loadItems(); }, []);

  useEffect(() => {
    window.addEventListener("storage-cleared", loadItems);
    window.addEventListener("rattin-network-recovery", loadItems);
    return () => { window.removeEventListener("storage-cleared", loadItems); window.removeEventListener("rattin-network-recovery", loadItems); };
  }, []);

  function handleRemove(item: SavedItem) {
    setItems((prev) => prev ? prev.filter((i) => i.tmdbId !== item.tmdbId) : prev);
    toggleSaved({
      tmdbId: item.tmdbId,
      mediaType: item.mediaType,
      title: item.title,
      posterPath: item.posterPath,
    }).catch(() => {
      setItems((prev) => prev ? [...prev, item] : [item]);
    });
  }

  return (
    <div className="my-list-page">
      <button className="back-btn" onClick={() => navigate(-1)}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
        </svg>
        Back
      </button>
      <div className="my-list-header">
        <h1>My List</h1>
        {items !== null && (
          <span className="my-list-count">{items.length} {items.length === 1 ? "title" : "titles"}</span>
        )}
      </div>

      {items === null ? (
        <div className="my-list-grid">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="movie-card">
              <div className="movie-card-poster skeleton" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="my-list-empty">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
          </svg>
          <p>Your list is empty</p>
          <span>Save movies and shows to watch later</span>
          <button className="my-list-browse-btn" onClick={() => navigate("/")}>
            Browse
          </button>
        </div>
      ) : (
        <div className="my-list-grid">
          {items.map((item) => {
            const type = item.mediaType || "movie";
            const img = poster(item.posterPath);
            return (
              <div
                key={`${type}:${item.tmdbId}`}
                className="movie-card my-list-card"
                onClick={() => navigate(`/${type}/${item.tmdbId}`)}
              >
                <div className="movie-card-poster">
                  {img ? (
                    <img src={img} alt={item.title} loading="lazy" />
                  ) : (
                    <div className="movie-card-placeholder" />
                  )}
                  <button
                    className="my-list-remove-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemove(item);
                    }}
                    title="Remove from list"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                    </svg>
                  </button>
                </div>
                <div className="movie-card-info">
                  <span className="movie-card-title">{item.title}</span>
                  {type === "tv" && item.season != null && (
                    <span className="movie-card-year">
                      S{item.season}E{item.episode}
                      {item.episodeTitle ? ` \u2014 ${item.episodeTitle}` : ""}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
