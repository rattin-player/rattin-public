import { useEffect, useRef } from "react";

export function useRefetchOnRecovery(callback: () => void): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;
  useEffect(() => {
    const handler = () => cbRef.current();
    window.addEventListener("rattin-network-recovery", handler);
    return () => window.removeEventListener("rattin-network-recovery", handler);
  }, []);
}
