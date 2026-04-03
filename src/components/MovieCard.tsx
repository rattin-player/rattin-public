import { memo } from "react";
import { useNavigate } from "react-router-dom";
import { poster } from "../lib/api";
import { ratingColor } from "../lib/utils";
import "./MovieCard.css";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface MovieCardProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any;
}

export default memo(function MovieCard({ item }: MovieCardProps) {
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
        {item.vote_average > 0 && (
          <span className="movie-card-rating" style={{ color: ratingColor(item.vote_average) }}>
            ★ {item.vote_average.toFixed(1)}
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
