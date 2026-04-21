export interface EpisodePosition {
  season?: number;
  episode?: number;
  seasonEpisodeCount?: number;
  seasonCount?: number;
}

export function nextEpisodeFrom(ep: EpisodePosition): { season: number; episode: number } | null {
  const season = ep.season ?? 1;
  const episode = ep.episode ?? 0;
  const isSeasonFinale = ep.seasonEpisodeCount != null && episode >= ep.seasonEpisodeCount;
  if (!isSeasonFinale) return { season, episode: episode + 1 };
  const isSeriesFinale = ep.seasonCount != null && season >= ep.seasonCount;
  if (isSeriesFinale) return null;
  return { season: season + 1, episode: 1 };
}
