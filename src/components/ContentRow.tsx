import { useState, useEffect, useRef } from "react";
import MovieCard from "./MovieCard";
import { checkAvailability } from "../lib/api";
import "./ContentRow.css";

export default function ContentRow({ title, fetchFn, filterAvailability = false }) {
  const [items, setItems] = useState(null);
  const scrollRef = useRef();

  useEffect(() => {
    let cancelled = false;
    fetchFn()
      .then(async (data) => {
        if (cancelled) return;
        const results = data.results || [];
        if (!filterAvailability || results.length === 0) {
          setItems(results);
          return;
        }
        const batch = results.map((r) => ({
          id: r.id,
          title: r.title || r.name,
          year: parseInt((r.release_date || r.first_air_date || "").slice(0, 4)) || undefined,
          type: r.media_type || (r.first_air_date ? "tv" : "movie"),
        }));
        const available = await checkAvailability(batch);
        if (!cancelled) setItems(results.filter((r) => available.has(r.id)));
      })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, []);

  function scroll(dir) {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * 600, behavior: "smooth" });
  }

  if (items !== null && items.length === 0) return null;

  return (
    <div className="content-row">
      <h2 className="content-row-title">{title}</h2>
      <div className="content-row-wrapper">
        <button className="content-row-arrow left" onClick={() => scroll(-1)}>‹</button>
        <div className="content-row-scroll" ref={scrollRef}>
          {items === null
            ? Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="movie-card">
                  <div className="movie-card-poster skeleton" />
                </div>
              ))
            : items.map((item) => <MovieCard key={item.id} item={item} />)}
        </div>
        <button className="content-row-arrow right" onClick={() => scroll(1)}>›</button>
      </div>
    </div>
  );
}
