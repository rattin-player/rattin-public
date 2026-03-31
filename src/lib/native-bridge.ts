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
 * Detection: `window.__NATIVE__` is set by a userScript injected at DocumentCreation,
 * `window.qt` is the webChannelTransport (may not exist in MainWorld on all Qt versions). */
export const isNative: boolean =
  typeof window !== "undefined" && ((window as any).__NATIVE__ === true || "qt" in window);

if (typeof window !== "undefined") {
  console.log("[native-bridge] isNative:", isNative, "__NATIVE__:", (window as any).__NATIVE__, "window.qt:", "qt" in window);
}

/** Wait for the QWebChannel bridge to become available (async setup). */
let _bridgeReady = false;
export function waitForBridge(): Promise<void> {
  if (_bridgeReady && window.mpvBridge) return Promise.resolve();
  console.log("[native-bridge] waitForBridge: polling for window.mpvBridge...");
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (window.mpvBridge) {
        _bridgeReady = true;
        clearInterval(check);
        console.log("[native-bridge] bridge ready!");
        resolve();
      }
    }, 50);
    // Safety timeout — if bridge never appears, resolve anyway (web mode fallback)
    setTimeout(() => {
      clearInterval(check);
      console.log("[native-bridge] waitForBridge timed out, mpvBridge:", !!window.mpvBridge);
      resolve();
    }, 5000);
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
