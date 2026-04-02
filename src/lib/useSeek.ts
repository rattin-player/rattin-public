import { useState, useEffect, useRef, useCallback, type RefObject, type MutableRefObject } from "react";
import { fetchStatus, fetchDuration } from "./api";
import { mpvSeek } from "./native-bridge";

interface EffectiveTime {
  time: number;
  duration: number;
  ts: number;
}

interface UseSeekDeps {
  infoHash: string;
  fileIndex: string;
  effectiveTimeRef: MutableRefObject<EffectiveTime | null>;
  dlProgressRef: MutableRefObject<number>;
  dlSpeedRef: MutableRefObject<number>;
  dlPeersRef: MutableRefObject<number>;
  seekRef: RefObject<HTMLDivElement | null>;
}

interface UseSeekReturn {
  currentTime: number;
  duration: number;
  playing: boolean;
  dlProgress: number;
  dlSpeed: number;
  numPeers: number;
  fileName: string;
  tooltipTime: number | null;
  tooltipX: number;
  getEffectiveTime: () => number;
  getEffectiveDuration: () => number;
  seekTo: (seconds: number) => void;
  handleSeekClick: (e: React.MouseEvent) => void;
  handleSeekHover: (e: React.MouseEvent) => void;
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  setTooltipTime: React.Dispatch<React.SetStateAction<number | null>>;
}

export function useSeek(deps: UseSeekDeps): UseSeekReturn {
  const {
    infoHash, fileIndex,
    effectiveTimeRef, dlProgressRef, dlSpeedRef, dlPeersRef,
    seekRef,
  } = deps;

  const [knownDuration, setKnownDuration] = useState(0);
  const [dlProgress, setDlProgress] = useState(0);
  const [dlSpeed, setDlSpeed] = useState(0);
  const [numPeers, setNumPeers] = useState(0);
  const [fileName, setFileName] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tooltipTime, setTooltipTime] = useState<number | null>(null);
  const [tooltipX, setTooltipX] = useState(0);

  const knownDurRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => { knownDurRef.current = knownDuration; }, [knownDuration]);

  const getEffectiveTime = useCallback(() => {
    return effectiveTimeRef.current?.time ?? 0;
  }, []);

  const getEffectiveDuration = useCallback(() => {
    if (knownDurRef.current > 0) return knownDurRef.current;
    return effectiveTimeRef.current?.duration ?? 0;
  }, []);

  function seekTo(seconds: number) {
    mpvSeek(seconds);
  }

  function handleSeekClick(e: React.MouseEvent) {
    if (!seekRef.current) return;
    const rect = seekRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = duration || getEffectiveDuration();
    if (dur > 0) seekTo(ratio * dur);
  }

  function handleSeekHover(e: React.MouseEvent) {
    if (!seekRef.current) return;
    const rect = seekRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = duration || getEffectiveDuration();
    setTooltipTime(dur > 0 ? ratio * dur : null);
    setTooltipX(ratio * 100);
  }

  async function fetchDurationRetry(ih: string, fi: string, retries = 5) {
    try {
      const data = await fetchDuration(ih, fi);
      if (data.duration) { setKnownDuration(data.duration); return; }
    } catch {}
    if (retries > 0) setTimeout(() => fetchDurationRetry(ih, fi, retries - 1), 5000);
  }

  // Fetch duration
  useEffect(() => {
    fetchDurationRetry(infoHash, fileIndex);
  }, [infoHash, fileIndex]);

  // Status polling — download progress, speed, peers
  useEffect(() => {
    async function poll() {
      try {
        const data = await fetchStatus(infoHash);
        if (!data.files) return;
        setDlSpeed(data.downloadSpeed || 0);
        setNumPeers(data.numPeers || 0);
        dlSpeedRef.current = data.downloadSpeed || 0;
        dlPeersRef.current = data.numPeers || 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const file = data.files.find((f: any) => f.index === Number(fileIndex));
        if (file) {
          setDlProgress(file.progress || 0);
          dlProgressRef.current = file.progress || 0;
          setFileName(file.name || "");
          if (file.duration && file.duration > 0 && knownDurRef.current === 0) {
            setKnownDuration(file.duration);
          }
        }
      } catch {}
    }
    poll();
    pollRef.current = setInterval(poll, 1500);
    return () => clearInterval(pollRef.current);
  }, [infoHash, fileIndex]);

  // Sync time/duration/playing from effectiveTimeRef (set by mpv events in Player.tsx)
  useEffect(() => {
    const interval = setInterval(() => {
      const eff = effectiveTimeRef.current;
      if (eff) {
        setCurrentTime(eff.time);
        const dur = knownDurRef.current > 0 ? knownDurRef.current : eff.duration;
        setDuration(dur);
      }
    }, 250);
    return () => clearInterval(interval);
  }, []);

  return {
    currentTime, duration, playing,
    dlProgress, dlSpeed, numPeers, fileName,
    tooltipTime, tooltipX,
    getEffectiveTime, getEffectiveDuration,
    seekTo, handleSeekClick, handleSeekHover,
    setPlaying, setTooltipTime,
  };
}
