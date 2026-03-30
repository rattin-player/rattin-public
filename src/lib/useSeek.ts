import { useState, useEffect, useRef, useCallback, type RefObject, type MutableRefObject } from "react";
import { fetchStatus, fetchDuration } from "./api";

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
  activeAudioRef: MutableRefObject<number | null>;
  startStream: (infoHash: string, fileIndex: string, title: string, tags: string[]) => void;
  mediaTitle: string;
  tags: string[];
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingReason: React.Dispatch<React.SetStateAction<string>>;
  pendingSubReload: MutableRefObject<number | null>;
  seekRef: RefObject<HTMLDivElement | null>;
}

interface UseSeekReturn {
  currentTime: number;
  duration: number;
  playing: boolean;
  seekOffset: number;
  isLiveTranscode: boolean;
  transcodeReady: boolean;
  knownDuration: number;
  dlProgress: number;
  dlSpeed: number;
  numPeers: number;
  fileName: string;
  tooltipTime: number | null;
  tooltipX: number;
  seekOffsetRef: MutableRefObject<number>;
  isLiveRef: MutableRefObject<boolean>;
  transcodeReadyRef: MutableRefObject<boolean>;
  knownDurRef: MutableRefObject<number>;
  getEffectiveTime: () => number;
  getEffectiveDuration: () => number;
  seekTo: (seconds: number) => void;
  handleSeekClick: (e: React.MouseEvent) => void;
  handleSeekHover: (e: React.MouseEvent) => void;
  switchToTranscoded: () => void;
  togglePlay: () => void;
  setTooltipTime: React.Dispatch<React.SetStateAction<number | null>>;
}

export function useSeek(videoRef: RefObject<HTMLVideoElement | null>, deps: UseSeekDeps): UseSeekReturn {
  const {
    infoHash, fileIndex,
    effectiveTimeRef, dlProgressRef, dlSpeedRef, dlPeersRef,
    activeAudioRef, startStream, mediaTitle, tags,
    setLoading, setLoadingReason, pendingSubReload,
    seekRef,
  } = deps;

  const [seekOffset, setSeekOffset] = useState(() => {
    try {
      const src = videoRef.current?.src;
      if (src) return parseFloat(new URL(src).searchParams.get("t") || "0") || 0;
    } catch {}
    return 0;
  });
  const [isLiveTranscode, setIsLiveTranscode] = useState(false);
  const [transcodeReady, setTranscodeReady] = useState(false);
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

  const seekOffsetRef = useRef(0);
  const isLiveRef = useRef(false);
  const transcodeReadyRef = useRef(false);
  const knownDurRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const seekingRef = useRef(false);

  // Sync state to refs
  useEffect(() => { seekOffsetRef.current = seekOffset; }, [seekOffset]);
  useEffect(() => { isLiveRef.current = isLiveTranscode; }, [isLiveTranscode]);
  useEffect(() => { transcodeReadyRef.current = transcodeReady; }, [transcodeReady]);
  useEffect(() => { knownDurRef.current = knownDuration; }, [knownDuration]);

  const getEffectiveTime = useCallback(() => {
    const v = videoRef.current;
    if (!v) return 0;
    return isLiveRef.current ? seekOffsetRef.current + (v.currentTime || 0) : v.currentTime || 0;
  }, []);

  const getEffectiveDuration = useCallback(() => {
    const v = videoRef.current;
    if (knownDurRef.current > 0) return knownDurRef.current;
    if (v?.duration && isFinite(v.duration)) {
      return isLiveRef.current ? seekOffsetRef.current + v.duration : v.duration;
    }
    return 0;
  }, []);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  function seekTo(seconds: number) {
    const v = videoRef.current;
    if (!v) return;
    if (isLiveRef.current) {
      const dur = getEffectiveDuration();
      // Clamp to duration but allow seeking anywhere — server fetches pieces on demand
      if (dur > 0 && seconds > dur) return;
      setSeekOffset(seconds);
      setIsLiveTranscode(true);
      setLoading(true);
      setLoadingReason("seeking");
      seekingRef.current = true;
      const audioParam = activeAudioRef.current !== null ? `&audio=${activeAudioRef.current}` : "";
      v.src = `/api/stream/${infoHash}/${fileIndex}?t=${seconds}${audioParam}`;
      v.play().catch(() => {});
      if (dur > 0) setKnownDuration(dur);
      // Defer subtitle reload — track must be added after new source loads
      pendingSubReload.current = seconds;
    } else {
      v.currentTime = seconds;
    }
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

  function switchToTranscoded() {
    const v = videoRef.current;
    if (!v) return;
    // Defer if currently seeking — wait for the seek to land first
    if (seekingRef.current) {
      v.addEventListener("canplay", function onReady() {
        v.removeEventListener("canplay", onReady);
        seekingRef.current = false;
        switchToTranscoded();
      }, { once: true });
      return;
    }
    const pos = getEffectiveTime();
    setLoading(true);
    setLoadingReason("initial");
    setIsLiveTranscode(false);
    setSeekOffset(0);
    v.src = `/api/stream/${infoHash}/${fileIndex}`;
    v.addEventListener("loadedmetadata", function onMeta() {
      v.removeEventListener("loadedmetadata", onMeta);
      v.currentTime = pos;
      v.play().catch(() => {});
    });
  }

  async function fetchDurationRetry(ih: string, fi: string, retries = 5) {
    try {
      const data = await fetchDuration(ih, fi);
      if (data.duration) { setKnownDuration(data.duration); return; }
    } catch {}
    if (retries > 0) setTimeout(() => fetchDurationRetry(ih, fi, retries - 1), 5000);
  }

  // Start or resume stream
  useEffect(() => {
    startStream(infoHash, fileIndex, mediaTitle, tags);
    fetchDurationRetry(infoHash, fileIndex);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [infoHash, fileIndex]);

  // Status polling
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
          // Pick up duration from status poll (may arrive before /api/duration)
          if (file.duration && file.duration > 0 && knownDurRef.current === 0) {
            setKnownDuration(file.duration);
          }
          const ext = (file.name || "").split(".").pop()!.toLowerCase();
          const needsXcode = !["mp4", "m4v", "webm"].includes(ext);
          if (needsXcode && !transcodeReadyRef.current) {
            setIsLiveTranscode(true);
          }
          if (file.transcodeStatus === "ready" && !transcodeReadyRef.current) {
            setTranscodeReady(true);
            switchToTranscoded();
          }
        }
      } catch {}
    }
    poll();
    pollRef.current = setInterval(poll, 1500);
    return () => clearInterval(pollRef.current);
  }, [infoHash, fileIndex]);

  // Time update — sync to local state AND push to context for mini player
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    function onTime() {
      const t = getEffectiveTime();
      const d = getEffectiveDuration();
      setCurrentTime(t);
      setDuration(d);
      setPlaying(!v!.paused);
      effectiveTimeRef.current = { time: t, duration: d, ts: Date.now() };
    }
    function onCanPlay() { seekingRef.current = false; }
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onTime);
    v.addEventListener("pause", onTime);
    v.addEventListener("canplay", onCanPlay);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onTime);
      v.removeEventListener("pause", onTime);
      v.removeEventListener("canplay", onCanPlay);
    };
  }, [getEffectiveTime, getEffectiveDuration]);

  return {
    currentTime, duration, playing, seekOffset,
    isLiveTranscode, transcodeReady, knownDuration,
    dlProgress, dlSpeed, numPeers, fileName,
    tooltipTime, tooltipX,
    seekOffsetRef, isLiveRef, transcodeReadyRef, knownDurRef,
    getEffectiveTime, getEffectiveDuration,
    seekTo, handleSeekClick, handleSeekHover, switchToTranscoded,
    togglePlay, setTooltipTime,
  };
}
