import { useState, useEffect, useMemo, useCallback, memo } from "react";
import { useNavigate } from "react-router-dom";
import HeroSection from "../components/HeroSection";
import ContentRow from "../components/ContentRow";
import { fetchTrending, fetchDiscover, fetchGenres } from "../lib/api";
import "./Home.css";

function recentDateRange() {
  const now = new Date();
  const from = new Date(now);
  from.setMonth(from.getMonth() - 2);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(now) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function Home() {
  const navigate = useNavigate();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [hero, setHero] = useState<any>(null);
  const [genres, setGenres] = useState<{ id: number; name: string }[]>([]);
  const [genreFilter, setGenreFilter] = useState("");
  const { from, to } = useMemo(() => recentDateRange(), []);

  const filteredGenres = genreFilter
    ? genres.filter((g) => g.name.toLowerCase().includes(genreFilter.toLowerCase()))
    : genres;

  useEffect(() => {
    fetchTrending().then((data) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = (data.results || []).filter((i: any) => i.backdrop_path && i.overview);
      if (items.length) setHero(items[0]);
    }).catch(() => {});
    fetchGenres().then((data) => setGenres(data.genres || [])).catch(() => {});
  }, []);

  return (
    <div className="home">
      <HeroSection item={hero} />
      <div className="home-genres">
        <div className="home-genre-search">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="var(--text-muted)">
            <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
          </svg>
          <input
            type="text"
            placeholder="Filter genres..."
            value={genreFilter}
            onChange={(e) => setGenreFilter(e.target.value)}
          />
        </div>
        {filteredGenres.map((g) => (
          <button
            key={g.id}
            className="home-genre-pill"
            onClick={() => navigate(`/search?genre=${g.id}&genreName=${encodeURIComponent(g.name)}&type=movie`)}
          >
            {g.name}
          </button>
        ))}
      </div>
      <ContentRows from={from} to={to} />
    </div>
  );
}

const ContentRows = memo(function ContentRows({ from, to }: { from: string; to: string }) {
  const fetchTrendingCb = useCallback(() => fetchTrending(), []);
  const fetchNewReleases = useCallback(() => fetchDiscover("movie", "", 1, "popularity.desc", `&primary_release_date.gte=${from}&primary_release_date.lte=${to}`), [from, to]);
  const fetchPopularMovies = useCallback(() => fetchDiscover("movie", "", 1, "popularity.desc"), []);
  const fetchPopularTV = useCallback(() => fetchDiscover("tv", "", 1, "popularity.desc"), []);
  const fetchTopMovies = useCallback(() => fetchDiscover("movie", "", 1, "vote_average.desc", "&vote_count.gte=5000"), []);
  const fetchTopTV = useCallback(() => fetchDiscover("tv", "", 1, "vote_average.desc", "&vote_count.gte=2000"), []);
  const fetchAction = useCallback(() => fetchDiscover("movie", 28), []);
  const fetchComedy = useCallback(() => fetchDiscover("movie", 35), []);
  const fetchSciFi = useCallback(() => fetchDiscover("movie", 878), []);
  const fetchHorror = useCallback(() => fetchDiscover("movie", 27), []);

  return (
    <div className="home-rows">
      <ContentRow title="Trending This Week" fetchFn={fetchTrendingCb} filterAvailability />
      <ContentRow title="New Releases" fetchFn={fetchNewReleases} filterAvailability />
      <ContentRow title="Popular Movies" fetchFn={fetchPopularMovies} filterAvailability />
      <ContentRow title="Popular TV Shows" fetchFn={fetchPopularTV} filterAvailability />
      <ContentRow title="Top Rated Movies" fetchFn={fetchTopMovies} filterAvailability />
      <ContentRow title="Top Rated TV" fetchFn={fetchTopTV} filterAvailability />
      <ContentRow title="Action" fetchFn={fetchAction} filterAvailability />
      <ContentRow title="Comedy" fetchFn={fetchComedy} filterAvailability />
      <ContentRow title="Sci-Fi" fetchFn={fetchSciFi} filterAvailability />
      <ContentRow title="Horror" fetchFn={fetchHorror} filterAvailability />
    </div>
  );
})
