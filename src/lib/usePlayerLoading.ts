import { useState, useEffect, useRef, type MutableRefObject } from "react";

const MESSAGES: Record<string, string[]> = {
  initial: [
    "Getting everything ready...",
    "Finding the best source...",
    "Connecting to peers...",
    "Almost there...",
    "Buffering the good stuff...",
    "Just a moment...",
    "Preparing your stream...",
    "Hang tight, nearly ready...",
    "Setting things up for you...",
  ],
  seeking: [
    "Skipping ahead...",
    "Jumping to that part...",
    "Rebuffering...",
    "Almost there...",
    "One sec...",
    "Loading from new position...",
  ],
};

interface UsePlayerLoadingDeps {
  infoHash: string;
  fileIndex: string;
  reloadActiveSub: ((offset: number) => void) | null;
}

interface UsePlayerLoadingReturn {
  loading: boolean;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  loadingReason: string;
  setLoadingReason: React.Dispatch<React.SetStateAction<string>>;
  loadingMsg: number;
  currentMessage: string;
  pendingSubReload: MutableRefObject<number | null>;
  reloadActiveSubRef: MutableRefObject<((offset: number) => void) | null>;
  MESSAGES: Record<string, string[]>;
}

export function usePlayerLoading(deps: UsePlayerLoadingDeps): UsePlayerLoadingReturn {
  const { infoHash, fileIndex, reloadActiveSub: reloadActiveSubProp } = deps;
  const reloadActiveSubRef = useRef(reloadActiveSubProp);
  useEffect(() => { reloadActiveSubRef.current = reloadActiveSubProp; }, [reloadActiveSubProp]);

  const [loading, setLoading] = useState(true);
  const [loadingMsg, setLoadingMsg] = useState(0);
  const [loadingReason, setLoadingReason] = useState("initial"); // "initial" | "seeking"
  const pendingSubReload = useRef<number | null>(null);

  // Rotate loading messages
  useEffect(() => {
    if (!loading) return;
    setLoadingMsg(0);
    const msgs = MESSAGES[loadingReason] || MESSAGES.initial;
    const interval = setInterval(() => {
      setLoadingMsg((prev) => (prev + 1) % msgs.length);
    }, 6000);
    return () => clearInterval(interval);
  }, [loading, loadingReason]);

  // Reset loading state when stream changes
  useEffect(() => {
    setLoading(true);
    setLoadingReason("initial");
  }, [infoHash, fileIndex]);

  // Trigger pending subtitle reload when loading clears
  useEffect(() => {
    if (!loading && pendingSubReload.current !== null) {
      const offset = pendingSubReload.current;
      pendingSubReload.current = null;
      if (reloadActiveSubRef.current) reloadActiveSubRef.current(offset);
    }
  }, [loading]);

  const msgs = MESSAGES[loadingReason] || MESSAGES.initial;
  const currentMessage = msgs[loadingMsg % msgs.length];

  return {
    loading, setLoading,
    loadingReason, setLoadingReason,
    loadingMsg,
    currentMessage,
    pendingSubReload,
    reloadActiveSubRef,
    MESSAGES,
  };
}
