import { useState, useEffect } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { fetchMovie, fetchTV, fetchSeason, fetchReviews, autoPlay, searchStreams, playTorrent, fetchAudioTracks, fetchSubtitleTracks, backdrop, poster, still } from "../lib/api";
import { ratingColor, formatBytes } from "../lib/utils";
import { useRemoteMode } from "../lib/PlayerContext";
import "./Detail.css";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface PrePlayState {
  infoHash: string;
  fileIndex: string;
  tags: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  audioTracks: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subtitleTracks: any[];
  selectedAudio: number | null;
  selectedSub: string;
  loading: boolean;
  season?: number | null;
  episode?: number | null;
}

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
  const [prePlay, setPrePlay] = useState<PrePlayState | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [reviews, setReviews] = useState<any>(null);
  const [expandedReview, setExpandedReview] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setPlayState(null);
    const fetcher = type === "tv" ? fetchTV : fetchMovie;
    fetcher(id!).then(setData).catch(() => {});
  }, [id, type]);

  useEffect(() => {
    setReviews(null);
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
      // Resolve actual file formats in background
      if (results.length > 0) {
        const hashes = results.map((s: { infoHash: string }) => s.infoHash).filter(Boolean);
        fetch("/api/resolve-formats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ infoHashes: hashes }),
        })
          .then((r) => r.json())
          .then((formats: Record<string, { native: boolean }>) => {
            setStreams((prev) =>
              prev?.map((s: { infoHash: string; tags: string[] }) => {
                const info = formats[s.infoHash];
                if (info?.native && !s.tags.includes("Native")) {
                  return { ...s, tags: [...s.tags, "Native"] };
                }
                return s;
              }) ?? null
            );
          })
          .catch(() => {});
      }
    } catch {
      setStreams([]);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function sendRemoteStart(result: any, tags: string[]) {
    fetch("/api/rc/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        action: "start-stream",
        value: { infoHash: result.infoHash, fileIndex: result.fileIndex, title: data.title || data.name, tags },
      }),
    }).catch(() => {});
    navigate(`/remote?session=${sessionId}`, {
      state: { pendingTitle: data.title || data.name },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handlePickStream(stream: any) {
    setShowPicker(false);
    setPlayState("loading");
    setPlayError("");
    try {
      const result = await playTorrent(stream.infoHash, stream.name, pickerSeason, pickerEpisode);
      if (isRemote) {
        sendRemoteStart(result, result.tags || stream.tags);
        return;
      }
      setPlayState(null);
      setPrePlay({
        infoHash: result.infoHash,
        fileIndex: result.fileIndex,
        tags: result.tags || stream.tags,
        audioTracks: [],
        subtitleTracks: [],
        selectedAudio: null,
        selectedSub: "",
        loading: true,
        season: pickerSeason,
        episode: pickerEpisode,
      });
      probeTracksForPrePlay(result.infoHash, result.fileIndex);
    } catch (err: unknown) {
      setPlayState("error");
      setPlayError((err as Error).message);
    }
  }

  async function probeTracksForPrePlay(infoHash: string, fileIndex: string) {
    let retries = 10;
    while (retries > 0) {
      try {
        const [audioData, subData] = await Promise.all([
          fetchAudioTracks(infoHash, fileIndex),
          fetchSubtitleTracks(infoHash, fileIndex),
        ]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const audioTracks = (audioData.tracks || []).map((t: any) => ({
          value: t.streamIndex,
          label: (t.title || t.lang || `Track ${t.streamIndex}`) + (t.channels > 2 ? " 5.1" : ""),
        }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const subtitleTracks = (subData.tracks || []).map((t: any) => ({
          value: `embedded:${t.streamIndex}`,
          label: t.title || t.lang || `Track ${t.streamIndex}`,
        }));
        if (audioTracks.length > 0 || subData.complete) {
          setPrePlay((prev) => prev ? {
            ...prev,
            audioTracks,
            subtitleTracks,
            selectedAudio: prev.selectedAudio ?? (audioTracks[0]?.value ?? null),
            loading: false,
          } : null);
          return;
        }
      } catch {}
      retries--;
      await new Promise((r) => setTimeout(r, 2000));
    }
    setPrePlay((prev) => prev ? { ...prev, loading: false } : null);
  }

  function launchPrePlay() {
    if (!prePlay) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const navState: any = {
      tags: prePlay.tags,
      title: data.title || data.name,
      tmdbId: id,
    };
    if (prePlay.season != null) {
      navState.season = prePlay.season;
      navState.episode = prePlay.episode;
    }
    if (prePlay.selectedAudio !== null) navState.audioTrack = prePlay.selectedAudio;
    if (prePlay.selectedSub) navState.subtitle = prePlay.selectedSub;
    navigate(`/play/${prePlay.infoHash}/${prePlay.fileIndex}`, { state: navState });
    setPrePlay(null);
  }

  function cancelPrePlay() {
    setPrePlay(null);
    setPlayState(null);
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
        sendRemoteStart(result, result.tags);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const navState: any = { tags: result.tags, title: data.title || data.name, tmdbId: id };
        if (season != null) {
          navState.season = season;
          navState.episode = episode;
        }
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
                  {reviews.reddit.map((t: any) => (
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
                  {reviews.reviews.map((r: any) => {
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
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {prePlay && (
        <div className="picker-overlay" onClick={cancelPrePlay}>
          <div className="picker-modal preplay-modal" onClick={(e) => e.stopPropagation()}>
            <div className="picker-header">
              <h3>Track Selection</h3>
              <button className="picker-close" onClick={cancelPrePlay}>&#10005;</button>
            </div>
            <div className="preplay-content">
              {prePlay.loading && <p className="preplay-loading">Detecting tracks...</p>}
              {prePlay.audioTracks.length > 1 && (
                <label className="preplay-field">
                  <span>Audio</span>
                  <select
                    value={prePlay.selectedAudio ?? ""}
                    onChange={(e) => setPrePlay((p) => p ? { ...p, selectedAudio: parseInt(e.target.value, 10) } : null)}
                  >
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {prePlay.audioTracks.map((t: any) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </label>
              )}
              {prePlay.subtitleTracks.length > 0 && (
                <label className="preplay-field">
                  <span>Subtitles</span>
                  <select
                    value={prePlay.selectedSub}
                    onChange={(e) => setPrePlay((p) => p ? { ...p, selectedSub: e.target.value } : null)}
                  >
                    <option value="">Off</option>
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {prePlay.subtitleTracks.map((t: any) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </label>
              )}
              <button className="detail-play-btn preplay-go" onClick={launchPrePlay}>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                Play
              </button>
            </div>
          </div>
        </div>
      )}

      {showPicker && (
        <div className="picker-overlay" onClick={() => setShowPicker(false)}>
          <div className="picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="picker-header">
              <h3>Select Source</h3>
              <button className="picker-close" onClick={() => setShowPicker(false)}>&#10005;</button>
            </div>
            <div className="picker-list">
              {streams === null ? (
                <div className="picker-loading">Searching providers...</div>
              ) : streams.length === 0 ? (
                <div className="picker-empty">No streams found</div>
              ) : (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                streams.map((s: any) => (
                  <button
                    key={s.infoHash}
                    className="picker-item"
                    onClick={() => handlePickStream(s)}
                  >
                    <div className="picker-item-main">
                      <span className="picker-item-name">{s.name}</span>
                      <div className="picker-item-tags">
                        {s.seasonPack && <span className="picker-tag season-pack">Season Pack</span>}
                        {s.tags.map((t: string) => (
                          <span key={t} className={`picker-tag${t === "Native" ? " native" : ""}`}>{t === "Native" ? "Full Seek" : t}</span>
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
