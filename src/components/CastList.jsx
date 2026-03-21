import { profile } from "../lib/api";
import "./CastList.css";

export default function CastList({ cast }) {
  if (!cast || cast.length === 0) return null;

  return (
    <div className="cast-list">
      <h3>Cast</h3>
      <div className="cast-scroll">
        {cast.slice(0, 20).map((person) => (
          <div key={person.id} className="cast-member">
            <div className="cast-photo">
              {person.profile_path ? (
                <img src={profile(person.profile_path)} alt={person.name} loading="lazy" />
              ) : (
                <div className="cast-placeholder">
                  <svg viewBox="0 0 24 24" width="28" height="28" fill="var(--text-muted)">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                  </svg>
                </div>
              )}
            </div>
            <span className="cast-name">{person.name}</span>
            <span className="cast-char">{person.character}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
