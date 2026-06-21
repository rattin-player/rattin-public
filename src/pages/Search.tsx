import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import MovieCard from "../components/MovieCard";
import { searchTMDB, fetchDiscover } from "../lib/api";
import { useRefetchOnRecovery } from "../lib/useRefetchOnRecovery";
import "./Search.css";

export default function Search() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get("q") || "";
  const genre = params.get("genre") || "";
  const genreName = params.get("genreName") || "";
  const mediaType = params.get("type") || "movie";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [results, setResults] = useState<any[] | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const queryKey = useRef("");
  const [recoveryKey, setRecoveryKey] = useState(0);
  useRefetchOnRecovery(useCallback(() => { queryKey.current = ""; setRecoveryKey((k) => k + 1); }, []));

  // Reset on query/genre change
  useEffect(() => {
    const key = `${q}:${genre}:${mediaType}`;
    if (key === queryKey.current) return;
    queryKey.current = key;
    setPage(1);
    setHasMore(false);

    if (genre) {
      setResults(null);
      fetchDiscover(mediaType, genre, 1).then((data) => {
        setResults(data.results || []);
        setHasMore((data.page || 1) < (data.total_pages || 1));
      }).catch(() => setResults([]));
      return;
    }
    if (!q) { setResults([]); return; }
    setResults(null);
    searchTMDB(q, 1).then((data) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filtered = (data.results || []).filter((r: any) => r.media_type === "movie" || r.media_type === "tv");
      setResults(filtered);
      setHasMore((data.page || 1) < (data.total_pages || 1));
    }).catch(() => setResults([]));
  }, [q, genre, mediaType, recoveryKey]);

  function loadMore() {
    const nextPage = page + 1;
    setLoadingMore(true);
    const fetch = genre
      ? fetchDiscover(mediaType, genre, nextPage)
      : searchTMDB(q, nextPage);
    fetch.then((data) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let newResults = data.results || [];
      if (!genre) newResults = newResults.filter((r: any) => r.media_type === "movie" || r.media_type === "tv");
      setResults((prev) => [...(prev || []), ...newResults]);
      setPage(nextPage);
      setHasMore((data.page || nextPage) < (data.total_pages || 1));
    }).catch(() => {}).finally(() => setLoadingMore(false));
  }

  const heading = genre
    ? `${genreName || "Genre"} ${mediaType === "tv" ? "TV Shows" : "Movies"}`
    : `Results for \u201c${q}\u201d`;

  return (
    <div className="search-page">
      <button className="app-back-link" onClick={() => navigate(-1)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
        </svg>
        Back
      </button>
      <div className="search-page-header">
        <span className="app-eyebrow">{genre ? "Browsing" : "Search"}</span>
        <h1 className="page-title">{heading}</h1>
      </div>
      {results === null ? (
        <div className="search-grid">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="movie-card"><div className="movie-card-poster skeleton" /></div>
          ))}
        </div>
      ) : results.length === 0 ? (
        <div className="app-empty">
          <div className="app-empty-icon">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
          </div>
          <h3 className="app-empty-title">No results found</h3>
          <p className="app-empty-sub">Try a different search term, or browse by genre from the home page.</p>
        </div>
      ) : (
        <>
          <div className="search-grid">
            {results.map((item) => <MovieCard key={item.id} item={item} />)}
          </div>
          {hasMore && (
            <div className="search-load-more">
              <button
                className="search-load-more-btn"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading..." : "Load More"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
