import { useState, useEffect, useRef } from "react";
import MovieCard from "./MovieCard";
import { checkAvailability } from "../lib/api";
import "./ContentRow.css";

interface ContentRowProps {
  title: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchFn: () => Promise<any>;
  filterAvailability?: boolean;
}

export default function ContentRow({ title, fetchFn, filterAvailability = false }: ContentRowProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [items, setItems] = useState<any[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then(async (data: any) => {
        if (cancelled) return;
        const results = data.results || [];
        if (!filterAvailability || results.length === 0) {
          setItems(results);
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const batch = results.map((r: any) => ({
          id: r.id,
          title: r.title || r.name,
          year: parseInt((r.release_date || r.first_air_date || "").slice(0, 4)) || undefined,
          type: r.media_type || (r.first_air_date ? "tv" : "movie"),
        }));
        const available = await checkAvailability(batch);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!cancelled) setItems(results.filter((r: any) => available.has(r.id)));
      })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [fetchFn]);

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
            ? Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="movie-card">
                  <div className="movie-card-poster skeleton" />
                </div>
              ))
            : items.map((item) => <MovieCard key={item.id} item={item} />)}
        </div>
        <button className="content-row-arrow right" onClick={() => scroll(1)}>&rsaquo;</button>
      </div>
    </div>
  );
}
