// src/lib/native-bridge.ts
// Thin bridge between React UI and Qt shell's mpv player.
// In web mode, all functions are no-ops. In native mode, they send
// commands to the MpvBridge C++ object via QWebChannel.
//
// QWebChannel is imported from the npm package so it's available in
// MainWorld as part of the React bundle. Qt's auto-injection of
// qwebchannel.js goes into IsolatedWorld which runJavaScript can't access.
// @ts-expect-error — no type declarations for qwebchannel npm package
import { QWebChannel } from "qwebchannel";

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

/** Connect to the QWebChannel and wire up the mpv bridge.
 * Uses the bundled QWebChannel class + qt.webChannelTransport (injected
 * by Qt into MainWorld when webChannel is set on WebEngineView). */
let _bridgeReady = false;
export function waitForBridge(): Promise<void> {
  if (_bridgeReady && window.mpvBridge) return Promise.resolve();

  return new Promise((resolve) => {
    const tryConnect = () => {
      const transport = (window as any).qt?.webChannelTransport;
      if (!transport) return false;

      console.log("[native-bridge] connecting QWebChannel...");
      new QWebChannel(transport, (channel: any) => {
        const bridge = channel.objects.bridge;
        if (!bridge) {
          console.error("[native-bridge] 'bridge' not in channel objects:", Object.keys(channel.objects));
          resolve();
          return;
        }
        window.mpvBridge = bridge;
        window.mpvEvents = {
          onTimeChanged: null,
          onDurationChanged: null,
          onEofReached: null,
          onPauseChanged: null,
        };
        bridge.timeChanged.connect((s: number) => {
          if (window.mpvEvents?.onTimeChanged) window.mpvEvents.onTimeChanged(s);
        });
        bridge.durationChanged.connect((s: number) => {
          if (window.mpvEvents?.onDurationChanged) window.mpvEvents.onDurationChanged(s);
        });
        bridge.eofReached.connect(() => {
          if (window.mpvEvents?.onEofReached) window.mpvEvents.onEofReached();
        });
        bridge.pauseChanged.connect((p: boolean) => {
          if (window.mpvEvents?.onPauseChanged) window.mpvEvents.onPauseChanged(p);
        });
        _bridgeReady = true;
        console.log("[native-bridge] bridge connected!");
        resolve();
      });
      return true;
    };

    // qt.webChannelTransport may not exist yet if page just loaded
    if (!tryConnect()) {
      console.log("[native-bridge] waiting for qt.webChannelTransport...");
      let attempts = 0;
      const poll = setInterval(() => {
        if (tryConnect() || ++attempts > 200) {
          clearInterval(poll);
          if (attempts > 200) {
            console.error("[native-bridge] transport never appeared");
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
