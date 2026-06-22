import { memo } from "react";
import { useNavigate } from "react-router-dom";
import { poster } from "../lib/api";
import { ratingColor } from "../lib/utils";
import "./MovieCard.css";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface MovieCardProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any;
  warning?: string;
}

export default memo(function MovieCard({ item, warning }: MovieCardProps) {
  const navigate = useNavigate();
  const type = item.media_type || (item.first_air_date ? "tv" : "movie");
  const title = item.title || item.name;
  const year = (item.release_date || item.first_air_date || "").slice(0, 4);
  const img = poster(item.poster_path);

  return (
    <div className="movie-card" onClick={() => navigate(`/${type}/${item.id}`)}>
      <div className="movie-card-poster">
        {img ? (
          <img src={img} alt={title} loading="lazy" />
        ) : (
          <div className="movie-card-placeholder" />
        )}
        {warning && (
          <span className="movie-card-quality-badge" title={warning}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
        )}
        {item.vote_average > 0 && (
          <span className="movie-card-rating" style={{ color: ratingColor(item.vote_average) }}>
            {item.vote_average.toFixed(1)}
          </span>
        )}
      </div>
      <div className="movie-card-info">
        <span className="movie-card-title">{title}</span>
        {year && <span className="movie-card-year">{year}</span>}
      </div>
    </div>
  );
})
