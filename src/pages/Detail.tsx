import { useState, useEffect, useRef } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { fetchMovie, fetchTV, fetchSeason, fetchReviews, autoPlay, searchStreams, playTorrent, backdrop, poster, still } from "../lib/api";
import { ratingColor, formatBytes } from "../lib/utils";
import { useRemoteMode } from "../lib/PlayerContext";
import SourcePicker from "../components/SourcePicker";
import "./Detail.css";

export default function Detail() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const type = location.pathname.startsWith("/tv") ? "tv" : "movie";
  const { isRemote, sessionId } = useRemoteMode();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any>(null);
  const [selectedSeason, setSelectedSeason] = useState(1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [episodes, setEpisodes] = useState<any>(null);
  const [playState, setPlayState] = useState<string | null>(null); // null | "loading" | "error"
  const [playError, setPlayError] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [streams, setStreams] = useState<any[] | null>(null);
  const [pickerSeason, setPickerSeason] = useState<number | undefined>(undefined);
  const [pickerEpisode, setPickerEpisode] = useState<number | undefined>(undefined);
  const [expandedEps, setExpandedEps] = useState(new Set<number>());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [reviews, setReviews] = useState<any>(null);
  const [expandedReview, setExpandedReview] = useState<string | null>(null);
  const [showAllReddit, setShowAllReddit] = useState(false);
  const [showAllReviews, setShowAllReviews] = useState(false);

  useEffect(() => {
    setData(null);
    setPlayState(null);
    const fetcher = type === "tv" ? fetchTV : fetchMovie;
    fetcher(id!).then(setData).catch(() => {});
  }, [id, type]);

  useEffect(() => {
    setReviews(null);
    setShowAllReddit(false);
    setShowAllReviews(false);
    fetchReviews(type, id!).then(setReviews).catch(() => setReviews({ reviews: [], reddit: [] }));
  }, [id, type]);

  useEffect(() => {
    if (type === "tv" && data) {
      setEpisodes(null);
      fetchSeason(id!, selectedSeason).then(setEpisodes).catch(() => {});
    }
  }, [id, selectedSeason, data]);

  async function openPicker(season?: number, episode?: number) {
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

  function displayTitle(season?: number, episode?: number): string {
    const name = data.title || data.name;
    if (season != null && episode != null) return `${name} — S${season}E${episode}`;
    return name;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function sendRemoteStart(result: any, tags: string[], season?: number, episode?: number) {
    const title = displayTitle(season, episode);
    const year = parseInt((data.release_date || data.first_air_date || "").slice(0, 4)) || undefined;
    const imdbId = data.imdb_id || data.external_ids?.imdb_id || undefined;
    fetch("/api/rc/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        action: "start-stream",
        value: {
          infoHash: result.infoHash, fileIndex: result.fileIndex, title, tags,
          debridStreamKey: result.debridStreamKey, year, type, season, episode, imdbId,
        },
      }),
    }).catch(() => {});
    navigate("/remote", {
      state: { pendingTitle: title },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handlePickStream(stream: any) {
    setShowPicker(false);
    setPlayState("loading");
    setPlayError("");
    try {
      const result = await playTorrent(stream.infoHash, stream.name, pickerSeason, pickerEpisode, stream.fileIdx);
      if (isRemote) {
        sendRemoteStart(result, result.tags || stream.tags, pickerSeason, pickerEpisode);
        return;
      }
      setPlayState(null);
      // Go straight to player — audio/subtitle selection available in-player
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const year = parseInt((data.release_date || data.first_air_date || "").slice(0, 4)) || undefined;
      const imdbId = data.imdb_id || data.external_ids?.imdb_id || undefined;
      const navState: any = {
        tags: result.tags || stream.tags, title: displayTitle(pickerSeason, pickerEpisode), tmdbId: id,
        year, type, imdbId, sources: streams,
      };
      if (pickerSeason != null) {
        navState.season = pickerSeason;
        navState.episode = pickerEpisode;
      }
      if (result.debridStreamKey) navState.debridStreamKey = result.debridStreamKey;
      navigate(`/play/${result.infoHash}/${result.fileIndex}`, { state: navState });
    } catch (err: unknown) {
      setPlayState("error");
      setPlayError((err as Error).message);
    }
  }

  async function handlePlay(season?: number, episode?: number) {
    if (playState === "loading") return;
    setPlayState("loading");
    setPlayError("");
    try {
      const title = data.title || data.name;
      const year = parseInt((data.release_date || data.first_air_date || "").slice(0, 4)) || undefined;
      const imdbId = data.imdb_id || data.external_ids?.imdb_id || undefined;
      const result = await autoPlay(title, year, type, season, episode, imdbId);
      if (isRemote) {
        sendRemoteStart(result, result.tags, season, episode);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const navState: any = { tags: result.tags, title: displayTitle(season, episode), tmdbId: id, year, type, imdbId };
        if (season != null) {
          navState.season = season;
          navState.episode = episode;
        }
        if (result.debridStreamKey) navState.debridStreamKey = result.debridStreamKey;
        navigate(`/play/${result.infoHash}/${result.fileIndex}`, { state: navState });
      }
    } catch (err: unknown) {
      setPlayState("error");
      setPlayError((err as Error).message);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seasons = data.seasons?.filter((s: any) => s.season_number > 0);
  const genres = data.genres || [];


  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trailer = (data.videos?.results || []).find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (v: any) => v.type === "Trailer" && v.site === "YouTube"
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
        <button className="back-btn" onClick={() => navigate(-1)}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
          </svg>
          Back
        </button>
        <div className="detail-main">
          <div className="detail-poster">
            {data.poster_path ? (
              <img src={poster(data.poster_path, "w500")!} alt={title} />
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
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {genres.map((g: any) => (
                <span
                  key={g.id}
                  className="detail-genre-pill"
                  onClick={() => navigate(`/search?genre=${g.id}&genreName=${encodeURIComponent(g.name)}&type=${type}`)}
                >
                  {g.name}
                </span>
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
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {seasons.map((s: any) => (
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
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (episodes.episodes || []).map((ep: any) => (
                  <div key={ep.id} className="episode-card">
                    {ep.still_path && (
                      <img className="episode-thumb" src={still(ep.still_path)!} alt="" loading="lazy" />
                    )}
                    <div className="episode-body">
                      <div className="episode-info">
                        <span className="episode-num">E{ep.episode_number}</span>
                        <div>
                          <span className="episode-title">{ep.name}</span>
                          {ep.runtime && <span className="episode-runtime">{ep.runtime}m</span>}
                          {ep.overview && (
                            <p
                              className={`episode-overview ${expandedEps.has(ep.id) ? "expanded" : ""}`}
                              onClick={() => setExpandedEps((prev) => {
                                const next = new Set(prev);
                                next.has(ep.id) ? next.delete(ep.id) : next.add(ep.id);
                                return next;
                              })}
                            >
                              {ep.overview}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="episode-actions">
                        <button
                          className="episode-pick"
                          onClick={() => openPicker(selectedSeason, ep.episode_number)}
                          title="Pick source"
                        >
                          &hellip;
                        </button>
                        <button
                          className="episode-play"
                          onClick={() => handlePlay(selectedSeason, ep.episode_number)}
                          disabled={playState === "loading"}
                        >
                          &#9654;
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {reviews && (reviews.reviews.length > 0 || reviews.reddit.length > 0) && (
          <div className="reviews-section">
            {reviews.reddit.length > 0 && (
              <div className="reviews-block">
                <div className="reviews-header">
                  <h3>Reddit Discussions</h3>
                </div>
                <div className="reddit-list">
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {(showAllReddit ? reviews.reddit : reviews.reddit.slice(0, 3)).map((t: any) => (
                    <a
                      key={t.id}
                      className="reddit-card"
                      href={t.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <div className="reddit-card-main">
                        <span className="reddit-title">{t.title}</span>
                        <div className="reddit-meta">
                          <span className="reddit-sub">{t.subreddit}</span>
                          {t.flair && <span className="reddit-flair">{t.flair}</span>}
                        </div>
                      </div>
                      <div className="reddit-stats">
                        <span className="reddit-score">
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                            <path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z" />
                          </svg>
                          {t.score >= 1000 ? `${(t.score / 1000).toFixed(1)}k` : t.score}
                        </span>
                        <span className="reddit-comments">
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                          </svg>
                          {t.comments >= 1000 ? `${(t.comments / 1000).toFixed(1)}k` : t.comments}
                        </span>
                      </div>
                    </a>
                  ))}
                  {!showAllReddit && reviews.reddit.length > 3 && (
                    <button className="reviews-show-more" onClick={() => setShowAllReddit(true)}>
                      Show more ({reviews.reddit.length - 3})
                    </button>
                  )}
                </div>
              </div>
            )}

            {reviews.reviews.length > 0 && (
              <div className="reviews-block">
                <div className="reviews-header">
                  <h3>Reviews</h3>
                  {reviews.imdbId && (
                    <a
                      className="reviews-imdb-link"
                      href={`https://www.imdb.com/title/${reviews.imdbId}/reviews`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Read on IMDb
                    </a>
                  )}
                </div>
                <div className="reviews-list">
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {(showAllReviews ? reviews.reviews : reviews.reviews.slice(0, 3)).map((r: any) => {
                    const isExpanded = expandedReview === r.id;
                    const isLong = r.content.length > 300;
                    return (
                      <div key={r.id} className="review-card">
                        <div className="review-author">
                          {r.avatar ? (
                            <img className="review-avatar" src={r.avatar} alt="" />
                          ) : (
                            <div className="review-avatar-placeholder">
                              {r.author.charAt(0).toUpperCase()}
                            </div>
                          )}
                          <span className="review-author-name">{r.author}</span>
                          {r.rating && (
                            <span className="review-author-rating" style={{ color: ratingColor(r.rating) }}>
                              ★ {r.rating}/10
                            </span>
                          )}
                        </div>
                        <p className={`review-content${isExpanded ? " expanded" : ""}`}>
                          {isExpanded || !isLong ? r.content : r.content.slice(0, 300) + "..."}
                        </p>
                        {isLong && (
                          <button
                            className="review-toggle"
                            onClick={() => setExpandedReview(isExpanded ? null : r.id)}
                          >
                            {isExpanded ? "Show less" : "Read more"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {!showAllReviews && reviews.reviews.length > 3 && (
                    <button className="reviews-show-more" onClick={() => setShowAllReviews(true)}>
                      Show more ({reviews.reviews.length - 3})
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {showPicker && (
        <SourcePicker
          streams={streams}
          onPick={handlePickStream}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
