export interface EpisodePosition {
  season?: number;
  episode?: number;
  seasonEpisodeCount?: number;
  seasonCount?: number;
}

export function nextEpisodeFrom(ep: EpisodePosition): { season: number; episode: number } | null {
  const season = ep.season ?? 1;
  const episode = ep.episode ?? 0;
  // A 0 or negative count means "unknown" — a season with 0 episodes doesn't exist.
  // Treating 0 as known would make every episode a false season finale and wrongly roll over seasons.
  const knownEpCount = ep.seasonEpisodeCount != null && ep.seasonEpisodeCount > 0;
  const isSeasonFinale = knownEpCount && episode >= (ep.seasonEpisodeCount as number);
  if (!isSeasonFinale) return { season, episode: episode + 1 };
  const knownSeasonCount = ep.seasonCount != null && ep.seasonCount > 0;
  const isSeriesFinale = knownSeasonCount && season >= (ep.seasonCount as number);
  if (isSeriesFinale) return null;
  return { season: season + 1, episode: 1 };
}
