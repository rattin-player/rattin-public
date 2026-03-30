import { useState, useEffect, useRef, useCallback } from "react";
import { fetchIntroTimestamps } from "./api";

export function useIntro(videoRef, deps) {
  const { infoHash, fileIndex, introRangeRef, getEffectiveTime, seekTo, location, mediaTitle } = deps;

  const [introRange, setIntroRange] = useState(null);
  const [showSkipIntro, setShowSkipIntro] = useState(false);
  const skipIntroHideTimer = useRef(null);
  const wasInIntroRange = useRef(false);

  // Fetch intro timestamps for skip-intro button
  useEffect(() => {
    const tmdbId = location.state?.tmdbId;
    const season = location.state?.season;
    const episode = location.state?.episode;

    if (!infoHash || !fileIndex) return;

    let cancelled = false;
    // Retry periodically — files may not be ready on first attempt (still downloading)
    async function tryFetch() {
      try {
        const data = await fetchIntroTimestamps(infoHash, fileIndex, {
          tmdbId, season, episode, title: mediaTitle,
        });
        if (!cancelled && data.detected) {
          const range = { start: data.intro_start, end: data.intro_end };
          setIntroRange(range);
          introRangeRef.current = range;
          return true;
        }
      } catch {}
      return false;
    }

    let attempt = 0;
    const maxAttempts = 5;
    const delays = [3000, 15000, 30000, 60000, 120000]; // 3s, 15s, 30s, 1m, 2m
    function scheduleNext() {
      if (cancelled || attempt >= maxAttempts) return;
      const delay = delays[attempt] || 60000;
      attempt++;
      setTimeout(async () => {
        if (cancelled) return;
        const found = await tryFetch();
        if (!found) scheduleNext();
      }, delay);
    }
    scheduleNext();

    return () => { cancelled = true; };
  }, [infoHash, fileIndex]);

  // Show/hide skip intro button based on current playback time
  useEffect(() => {
    if (!introRange) return;
    const v = videoRef.current;
    if (!v) return;

    function checkIntro() {
      const t = getEffectiveTime();
      const inRange = t >= introRange.start && t < introRange.end;
      if (inRange && !wasInIntroRange.current) {
        // Entering intro range — show button and start auto-hide timer once
        setShowSkipIntro(true);
        clearTimeout(skipIntroHideTimer.current);
        skipIntroHideTimer.current = setTimeout(() => setShowSkipIntro(false), 10000);
      } else if (!inRange && wasInIntroRange.current) {
        // Leaving intro range — hide button
        setShowSkipIntro(false);
        clearTimeout(skipIntroHideTimer.current);
      }
      wasInIntroRange.current = inRange;
    }

    v.addEventListener("timeupdate", checkIntro);
    return () => {
      v.removeEventListener("timeupdate", checkIntro);
      clearTimeout(skipIntroHideTimer.current);
    };
  }, [introRange, getEffectiveTime]);

  const handleSkipIntro = useCallback(() => {
    if (!introRange) return;
    seekTo(introRange.end);
    setShowSkipIntro(false);
  }, [introRange, seekTo]);

  return { introRange, showSkipIntro, handleSkipIntro };
}
