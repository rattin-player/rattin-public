// src/lib/native-bridge.ts
// Thin bridge between React UI and Qt shell's mpv player.
// In web mode, all functions are no-ops. In native mode, they send
// commands to the MpvBridge C++ object via QWebChannel.

interface MpvBridge {
  play(url: string): void;
  pause(): void;
  resume(): void;
  seek(seconds: number): void;
  setVolume(percent: number): void;
  setAudioTrack(index: number): void;
  setSubtitleTrack(index: number): void;
  stop(): void;
  getProperty(name: string): Promise<unknown>;
}

interface MpvEvents {
  onTimeChanged: ((seconds: number) => void) | null;
  onDurationChanged: ((seconds: number) => void) | null;
  onEofReached: (() => void) | null;
  onPauseChanged: ((paused: boolean) => void) | null;
}

declare global {
  interface Window {
    mpvBridge?: MpvBridge;
    mpvEvents?: MpvEvents;
  }
}

/** True when running inside the Qt shell.
 * QtWebEngine always provides `window.qt` (the webChannelTransport).
 * `window.mpvBridge` is set asynchronously after QWebChannel connects,
 * so we cannot use it for sync detection at module load time. */
export const isNative: boolean =
  typeof window !== "undefined" && "qt" in window;

/** Wait for the QWebChannel bridge to become available (async setup). */
let _bridgeReady = false;
export function waitForBridge(): Promise<void> {
  if (_bridgeReady && window.mpvBridge) return Promise.resolve();
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (window.mpvBridge) { _bridgeReady = true; clearInterval(check); resolve(); }
    }, 50);
    // Safety timeout — if bridge never appears, resolve anyway (web mode fallback)
    setTimeout(() => { clearInterval(check); resolve(); }, 5000);
  });
}

// ── Commands (send to mpv) ──────────────────────────────────────────

export function mpvPlay(url: string): void {
  window.mpvBridge?.play(url);
}

export function mpvPause(): void {
  window.mpvBridge?.pause();
}

export function mpvResume(): void {
  window.mpvBridge?.resume();
}

export function mpvSeek(seconds: number): void {
  window.mpvBridge?.seek(seconds);
}

export function mpvSetVolume(percent: number): void {
  window.mpvBridge?.setVolume(percent);
}

export function mpvSetAudioTrack(index: number): void {
  window.mpvBridge?.setAudioTrack(index);
}

export function mpvSetSubtitleTrack(index: number): void {
  window.mpvBridge?.setSubtitleTrack(index);
}

export function mpvStop(): void {
  window.mpvBridge?.stop();
}

// ── Events (receive from mpv) ───────────────────────────────────────

export function onMpvTimeChanged(cb: (seconds: number) => void): void {
  if (window.mpvEvents) window.mpvEvents.onTimeChanged = cb;
}

export function onMpvDurationChanged(cb: (seconds: number) => void): void {
  if (window.mpvEvents) window.mpvEvents.onDurationChanged = cb;
}

export function onMpvEofReached(cb: () => void): void {
  if (window.mpvEvents) window.mpvEvents.onEofReached = cb;
}

export function onMpvPauseChanged(cb: (paused: boolean) => void): void {
  if (window.mpvEvents) window.mpvEvents.onPauseChanged = cb;
}
