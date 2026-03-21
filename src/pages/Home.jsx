import { useState, useEffect } from "react";
import HeroSection from "../components/HeroSection";
import ContentRow from "../components/ContentRow";
import { fetchTrending, fetchDiscover } from "../lib/api";
import "./Home.css";

function recentDateRange() {
  const now = new Date();
  const from = new Date(now);
  from.setMonth(from.getMonth() - 2);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(now) };
}

export default function Home() {
  const [hero, setHero] = useState(null);
  const { from, to } = recentDateRange();

  useEffect(() => {
    fetchTrending().then((data) => {
      const items = (data.results || []).filter((i) => i.backdrop_path && i.overview);
      if (items.length) setHero(items[0]);
    }).catch(() => {});
  }, []);

  return (
    <div className="home">
      <HeroSection item={hero} />
      <div className="home-rows">
        <ContentRow title="Trending This Week" fetchFn={() => fetchTrending()} filterAvailability />
        <ContentRow
          title="New Releases"
          fetchFn={() => fetchDiscover("movie", "", 1, "popularity.desc", `&primary_release_date.gte=${from}&primary_release_date.lte=${to}`)}
          filterAvailability
        />
        <ContentRow title="Popular Movies" fetchFn={() => fetchDiscover("movie", "", 1, "popularity.desc")} filterAvailability />
        <ContentRow title="Popular TV Shows" fetchFn={() => fetchDiscover("tv", "", 1, "popularity.desc")} filterAvailability />
        <ContentRow
          title="Top Rated Movies"
          fetchFn={() => fetchDiscover("movie", "", 1, "vote_average.desc", "&vote_count.gte=5000")}
          filterAvailability
        />
        <ContentRow
          title="Top Rated TV"
          fetchFn={() => fetchDiscover("tv", "", 1, "vote_average.desc", "&vote_count.gte=2000")}
          filterAvailability
        />
        <ContentRow title="Action" fetchFn={() => fetchDiscover("movie", 28)} filterAvailability />
        <ContentRow title="Comedy" fetchFn={() => fetchDiscover("movie", 35)} filterAvailability />
        <ContentRow title="Sci-Fi" fetchFn={() => fetchDiscover("movie", 878)} filterAvailability />
        <ContentRow title="Horror" fetchFn={() => fetchDiscover("movie", 27)} filterAvailability />
      </div>
    </div>
  );
}
