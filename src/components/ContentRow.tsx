import { useState, useEffect, useRef, useCallback } from "react";
import MovieCard from "./MovieCard";
import { checkAvailability } from "../lib/api";
import { useRefetchOnRecovery } from "../lib/useRefetchOnRecovery";
import { getHomeCache, setHomeCache } from "../lib/home-cache";
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
  const [recoveryKey, setRecoveryKey] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useRefetchOnRecovery(useCallback(() => setRecoveryKey((k) => k + 1), []));

  useEffect(() => {
    // Instant render from frontend cache (survives app restarts)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cached = getHomeCache<any>(`row:${title}`);
    if (cached) setItems(cached.results || []);

    let cancelled = false;
    fetchFn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then(async (data: any) => {
        if (cancelled) return;
        setHomeCache(`row:${title}`, data);
        const results = data.results || [];
        if (!filterAvailability || results.length === 0) {
          setItems(results);
          return;
        }
        // Render immediately — don't block on availability check.
        // Unavailable items are filtered out after the check returns.
        setItems(results);
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
  }, [fetchFn, recoveryKey, title]);

  function scroll(dir: number) {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * 600, behavior: "smooth" });
  }

  if (items !== null && items.length === 0) return null;

  return (
    <div className="content-row">
      <div className="content-row-header">
        <h2 className="content-row-title">{title}</h2>
      </div>
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
