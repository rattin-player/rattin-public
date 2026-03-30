import { useState, useEffect } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { fetchMovie, fetchTV, fetchSeason, autoPlay, searchStreams, playTorrent, backdrop, poster } from "../lib/api";
import { ratingColor, formatBytes } from "../lib/utils";
import { useRemoteMode } from "../lib/PlayerContext";
import "./Detail.css";

export default function Detail() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const type = location.pathname.startsWith("/tv") ? "tv" : "movie";
  const { isRemote, sessionId } = useRemoteMode();
  const [data, setData] = useState(null);
  const [selectedSeason, setSelectedSeason] = useState(1);
  const [episodes, setEpisodes] = useState(null);
  const [playState, setPlayState] = useState(null); // null | "loading" | "error"
  const [playError, setPlayError] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [streams, setStreams] = useState(null);
  const [pickerSeason, setPickerSeason] = useState(null);
  const [pickerEpisode, setPickerEpisode] = useState(null);

  useEffect(() => {
    setData(null);
    setPlayState(null);
    const fetcher = type === "tv" ? fetchTV : fetchMovie;
    fetcher(id).then(setData).catch(() => {});
  }, [id, type]);

  useEffect(() => {
    if (type === "tv" && data) {
      setEpisodes(null);
      fetchSeason(id, selectedSeason).then(setEpisodes).catch(() => {});
    }
  }, [id, selectedSeason, data]);

  async function openPicker(season, episode) {
    setPickerSeason(season);
    setPickerEpisode(episode);
    setShowPicker(true);
    setStreams(null);
    try {
      const title = data.title || data.name;
      const year = parseInt((data.release_date || data.first_air_date || "").slice(0, 4)) || undefined;
      const imdbId = data.imdb_id || data.external_ids?.imdb_id || undefined;
      const results = await searchStreams(title, year, type, season, episode, imdbId);
      setStreams(results);
    } catch {
      setStreams([]);
    }
  }

  function sendRemoteStart(result, tags) {
    fetch("/api/rc/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        action: "start-stream",
        value: { infoHash: result.infoHash, fileIndex: result.fileIndex, title: data.title || data.name, tags },
      }),
    }).catch(() => {});
    navigate(`/remote?session=${sessionId}`);
  }

  async function handlePickStream(stream) {
    setShowPicker(false);
    setPlayState("loading");
    setPlayError("");
    try {
      const result = await playTorrent(stream.infoHash, stream.name, pickerSeason, pickerEpisode);
      if (isRemote) {
        sendRemoteStart(result, result.tags || stream.tags);
      } else {
        navigate(`/play/${result.infoHash}/${result.fileIndex}`, {
          state: { tags: result.tags || stream.tags, title: data.title || data.name },
        });
      }
    } catch (err) {
      setPlayState("error");
      setPlayError(err.message);
    }
  }

  async function handlePlay(season, episode) {
    if (playState === "loading") return;
    setPlayState("loading");
    setPlayError("");
    try {
      const title = data.title || data.name;
      const year = parseInt((data.release_date || data.first_air_date || "").slice(0, 4)) || undefined;
      const imdbId = data.imdb_id || data.external_ids?.imdb_id || undefined;
      const result = await autoPlay(title, year, type, season, episode, imdbId);
      if (isRemote) {
        sendRemoteStart(result, result.tags);
      } else {
        navigate(`/play/${result.infoHash}/${result.fileIndex}`, {
          state: { tags: result.tags, title: data.title || data.name },
        });
      }
    } catch (err) {
      setPlayState("error");
      setPlayError(err.message);
    }
  }

  if (!data) {
    return (
      <div className="detail">
        <div className="detail-backdrop skeleton" style={{ height: "60vh" }} />
      </div>
    );
  }

  const title = data.title || data.name;
  const year = (data.release_date || data.first_air_date || "").slice(0, 4);
  const runtime = data.runtime ? `${Math.floor(data.runtime / 60)}h ${data.runtime % 60}m` : null;
  const seasons = data.seasons?.filter((s) => s.season_number > 0);
  const genres = data.genres || [];


  const trailer = (data.videos?.results || []).find(
    (v) => v.type === "Trailer" && v.site === "YouTube"
  );

  return (
    <div className="detail">
      <div
        className="detail-backdrop"
        style={{ backgroundImage: data.backdrop_path ? `url(${backdrop(data.backdrop_path)})` : "none" }}
      >
        <div className="detail-backdrop-overlay" />
      </div>
      <div className="detail-content">
        <div className="detail-main">
          <div className="detail-poster">
            {data.poster_path ? (
              <img src={poster(data.poster_path, "w500")} alt={title} />
            ) : (
              <div className="detail-poster-placeholder" />
            )}
          </div>
          <div className="detail-info">
            <h1>{title}</h1>
            <div className="detail-meta">
              {year && <span>{year}</span>}
              {runtime && <span>{runtime}</span>}
              {seasons && <span>{seasons.length} Season{seasons.length !== 1 ? "s" : ""}</span>}
              {data.vote_average > 0 && (
                <span className="detail-rating" style={{ color: ratingColor(data.vote_average) }}>
                  ★ {data.vote_average.toFixed(1)}
                  <span className="detail-votes">({data.vote_count?.toLocaleString()})</span>
                </span>
              )}
            </div>
            <div className="detail-genres">
              {genres.map((g) => (
                <span key={g.id} className="detail-genre-pill">{g.name}</span>
              ))}
            </div>
            <p className="detail-overview">{data.overview}</p>
            <div className="detail-actions">
              <button
                className="detail-play-btn"
                onClick={() => handlePlay()}
                disabled={playState === "loading"}
              >
                {playState === "loading" ? (
                  "Finding best stream..."
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    Play
                  </>
                )}
              </button>
              <button
                className="detail-source-btn"
                onClick={() => openPicker()}
                disabled={playState === "loading"}
              >
                Pick Source
              </button>
              {trailer && (
                <a
                  className="detail-trailer-btn"
                  href={`https://www.youtube.com/watch?v=${trailer.key}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Trailer
                </a>
              )}
            </div>
            {playState === "error" && (
              <div className="detail-error-box">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="var(--red)">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
                </svg>
                <div>
                  <p className="detail-error-title">
                    {playError === "not_found" ? "No streams available" : "Something went wrong"}
                  </p>
                  <p className="detail-error-sub">
                    {playError === "not_found"
                      ? "We couldn't find a good source for this title right now. Try again later or check a different release."
                      : "There was a problem setting up the stream. Please try again in a moment."}
                  </p>
                </div>
                <button className="detail-error-retry" onClick={() => { setPlayState(null); setPlayError(""); }}>
                  Dismiss
                </button>
              </div>
            )}
          </div>
        </div>

        {type === "tv" && seasons && (
          <div className="detail-seasons">
            <div className="detail-season-header">
              <h3>Episodes</h3>
              <select
                value={selectedSeason}
                onChange={(e) => setSelectedSeason(Number(e.target.value))}
              >
                {seasons.map((s) => (
                  <option key={s.season_number} value={s.season_number}>
                    Season {s.season_number}
                  </option>
                ))}
              </select>
            </div>
            <div className="detail-episodes">
              {episodes === null ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="episode-card skeleton" style={{ height: 80 }} />
                ))
              ) : (
                (episodes.episodes || []).map((ep) => (
                  <div key={ep.id} className="episode-card">
                    <div className="episode-info">
                      <span className="episode-num">E{ep.episode_number}</span>
                      <div>
                        <span className="episode-title">{ep.name}</span>
                        {ep.runtime && <span className="episode-runtime">{ep.runtime}m</span>}
                        {ep.overview && <p className="episode-overview">{ep.overview}</p>}
                      </div>
                    </div>
                    <div className="episode-actions">
                      <button
                        className="episode-pick"
                        onClick={() => openPicker(selectedSeason, ep.episode_number)}
                        title="Pick source"
                      >
                        ⋯
                      </button>
                      <button
                        className="episode-play"
                        onClick={() => handlePlay(selectedSeason, ep.episode_number)}
                        disabled={playState === "loading"}
                      >
                        ▶
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

      </div>

      {showPicker && (
        <div className="picker-overlay" onClick={() => setShowPicker(false)}>
          <div className="picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="picker-header">
              <h3>Select Source</h3>
              <button className="picker-close" onClick={() => setShowPicker(false)}>✕</button>
            </div>
            <div className="picker-list">
              {streams === null ? (
                <div className="picker-loading">Searching providers...</div>
              ) : streams.length === 0 ? (
                <div className="picker-empty">No streams found</div>
              ) : (
                streams.map((s) => (
                  <button
                    key={s.infoHash}
                    className="picker-item"
                    onClick={() => handlePickStream(s)}
                  >
                    <div className="picker-item-main">
                      <span className="picker-item-name">{s.name}</span>
                      <div className="picker-item-tags">
                        {s.seasonPack && <span className="picker-tag season-pack">Season Pack</span>}
                        {s.tags.map((t) => (
                          <span key={t} className="picker-tag">{t}</span>
                        ))}
                      </div>
                    </div>
                    <div className="picker-item-meta">
                      <span className="picker-source">{s.source.toUpperCase()}</span>
                      <span className="picker-seeds">
                        <span className="picker-seed-dot" />
                        {s.seeders}
                      </span>
                      <span className="picker-size">{formatBytes(s.size)}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
