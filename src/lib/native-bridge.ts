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
 * Detection via URL param `?native=1` set by the Qt shell in main.cpp.
 * This is evaluated at module load time and is reliable because the URL
 * is set before the page even starts loading. */
export const isNative: boolean =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("native") === "1";

if (isNative) {
  console.log("[native-bridge] native mode detected via URL param");
}

/** Wait for the QWebChannel bridge to become available, creating it if needed. */
let _bridgeReady = false;
export function waitForBridge(): Promise<void> {
  if (_bridgeReady && window.mpvBridge) return Promise.resolve();
  console.log("[native-bridge] waitForBridge: setting up QWebChannel...");

  return new Promise((resolve) => {
    // Try to create the bridge ourselves
    const tryConnect = () => {
      // Already set by someone else?
      if (window.mpvBridge) {
        _bridgeReady = true;
        console.log("[native-bridge] bridge already available");
        resolve();
        return;
      }

      const QWC = (window as any).QWebChannel;
      const transport = (window as any).qt?.webChannelTransport;

      console.log("[native-bridge] diag: QWebChannel=" + typeof QWC +
        " qt=" + typeof (window as any).qt +
        " transport=" + typeof transport);

      if (QWC && transport) {
        try {
          new QWC(transport, (channel: any) => {
            window.mpvBridge = channel.objects.bridge;
            console.log("[native-bridge] channel objects:", Object.keys(channel.objects));
            if (window.mpvBridge) {
              window.mpvEvents = {
                onTimeChanged: null,
                onDurationChanged: null,
                onEofReached: null,
                onPauseChanged: null,
              };
              window.mpvBridge.timeChanged.connect((s: number) => {
                if (window.mpvEvents?.onTimeChanged) window.mpvEvents.onTimeChanged(s);
              });
              window.mpvBridge.durationChanged.connect((s: number) => {
                if (window.mpvEvents?.onDurationChanged) window.mpvEvents.onDurationChanged(s);
              });
              window.mpvBridge.eofReached.connect(() => {
                if (window.mpvEvents?.onEofReached) window.mpvEvents.onEofReached();
              });
              window.mpvBridge.pauseChanged.connect((p: boolean) => {
                if (window.mpvEvents?.onPauseChanged) window.mpvEvents.onPauseChanged(p);
              });
              _bridgeReady = true;
              console.log("[native-bridge] bridge wired up successfully");
            }
            resolve();
          });
        } catch (e) {
          console.error("[native-bridge] QWebChannel error:", e);
          resolve();
        }
      } else {
        // Not ready yet, retry
        return false;
      }
      return true;
    };

    if (!tryConnect()) {
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        if (tryConnect() || attempts > 100) {
          clearInterval(poll);
          if (attempts > 100) {
            console.error("[native-bridge] gave up after 100 attempts");
            resolve();
          }
        }
      }, 50);
    }
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
