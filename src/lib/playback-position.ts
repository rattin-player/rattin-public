const MIN_THRESHOLD = 10;
const END_THRESHOLD = 30;

/** Build the sessionStorage key for a stream's playback position. */
export function playbackKey(infoHash: string, fileIndex: string | number): string {
  return `playback:${infoHash}:${fileIndex}`;
}

/** Decide whether a saved position should be restored. */
export function shouldRestorePosition(savedTime: number, duration: number): boolean {
  if (!Number.isFinite(savedTime) || savedTime <= 0) return false;
  if (duration <= 0) return false;
  if (savedTime > duration) return false;
  if (savedTime < MIN_THRESHOLD) return false;
  if (duration - savedTime < END_THRESHOLD) return false;
  return true;
}
