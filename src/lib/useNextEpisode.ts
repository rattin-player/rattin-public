import { useState, useEffect, useRef, useCallback, type MutableRefObject } from "react";

const FINISHED_THRESHOLD = 0.9; // same as watch-history.ts

interface EffectiveTime {
  time: number;
  duration: number;
  ts: number;
}

interface UseNextEpisodeDeps {
  getEffectiveTime: () => number;
  effectiveTimeRef: MutableRefObject<EffectiveTime | null>;
  location: { state?: Record<string, unknown> | null };
  onNextEpisode: (season: number, episode: number) => void;
}

interface UseNextEpisodeReturn {
  showNextEpisode: boolean;
  nextSeason: number;
  nextEpisode: number;
  handleNextEpisode: () => void;
}

export function useNextEpisode(deps: UseNextEpisodeDeps): UseNextEpisodeReturn {
  const { getEffectiveTime, effectiveTimeRef, location, onNextEpisode } = deps;

  const [showNextEpisode, setShowNextEpisode] = useState(false);
  const wasNearEnd = useRef(false);
  const dismissed = useRef(false);

  // Extract episode info from navigation state
  const state = location.state as Record<string, unknown> | null;
  const mediaType = (state?.type as string) ?? "";
  const currentSeason = state?.season != null ? Number(state.season) : 0;
  const currentEpisode = state?.episode != null ? Number(state.episode) : 0;
  const seasonEpisodeCount = state?.seasonEpisodeCount != null ? Number(state.seasonEpisodeCount) : 0;

  // Compute next episode
  const isTV = mediaType === "tv" && currentSeason > 0 && currentEpisode > 0;
  const isSeasonFinale = seasonEpisodeCount > 0 && currentEpisode >= seasonEpisodeCount;
  const nextSeason = isSeasonFinale ? currentSeason + 1 : currentSeason;
  const nextEpisode = isSeasonFinale ? 1 : currentEpisode + 1;

  // Poll playback position to detect when we're near the end
  useEffect(() => {
    if (!isTV) return;
    dismissed.current = false;
    wasNearEnd.current = false;
    setShowNextEpisode(false);

    function check() {
      if (dismissed.current) return;
      const eff = effectiveTimeRef.current;
      if (!eff || eff.duration <= 0) return;
      const ratio = eff.time / eff.duration;
      const nearEnd = ratio >= FINISHED_THRESHOLD;

      if (nearEnd && !wasNearEnd.current) {
        setShowNextEpisode(true);
      }
      wasNearEnd.current = nearEnd;
    }

    const interval = setInterval(check, 500);
    return () => clearInterval(interval);
  }, [isTV, effectiveTimeRef]);

  const handleNextEpisode = useCallback(() => {
    dismissed.current = true;
    setShowNextEpisode(false);
    onNextEpisode(nextSeason, nextEpisode);
  }, [nextSeason, nextEpisode, onNextEpisode]);

  return {
    showNextEpisode: showNextEpisode && isTV,
    nextSeason,
    nextEpisode,
    handleNextEpisode,
  };
}
