// src/lib/native-bridge.ts
// Bridge between React UI and Qt shell's native mpv video player.
//
// This app is a Qt WebEngineView with a native mpv player rendered on top.
// React does NOT render video — mpv does, via an OpenGL surface in QML.
// React sends commands to mpv (play, seek, stop) and receives events back
// (time updates, EOF, pause changes, track changes from QML's native overlay).
//
// The communication path is:
//   React → this file → QWebChannel → QML transport (main.qml) → MpvBridge (C++)
//   MpvBridge (C++) → QML → QWebChannel signals → window.mpvEvents callbacks → React
//
// QML also has its own native controls overlay (play/pause, seek, volume, CC)
// that sits on top of the mpv surface. When the user interacts with those
// controls, QML emits signals (nativeSubChanged, backRequested, etc.) that
// this bridge forwards to React so it can update its state.
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
  setTitle(title: string): void;
  setProperty(name: string, value: unknown): void;
  getProperty(name: string): Promise<unknown>;
}

interface MpvEvents {
  onTimeChanged: ((seconds: number) => void) | null;
  onDurationChanged: ((seconds: number) => void) | null;
  onEofReached: (() => void) | null;
  onPauseChanged: ((paused: boolean) => void) | null;
  onIsPlayingChanged: ((playing: boolean) => void) | null;
  onNativeSubChanged: ((mpvId: number) => void) | null;
  onNativeAudioChanged: ((mpvId: number) => void) | null;
  onNativeVolumeChanged: ((percent: number) => void) | null;
  onNativeSubSizeChanged: ((size: number) => void) | null;
  onToggleSourcePanel: (() => void) | null;
  onBackRequested: (() => void) | null;
}

declare global {
  interface Window {
    mpvBridge?: MpvBridge;
    mpvEvents?: MpvEvents;
  }
}

/** Connect to the QWebChannel and wire up the mpv bridge.
 * Uses the bundled QWebChannel class + qt.webChannelTransport (injected
 * by Qt into MainWorld when webChannel is set on WebEngineView). */
let _bridgeReady = false;
let _connectingPromise: Promise<void> | null = null;
export function waitForBridge(): Promise<void> {
  if (_bridgeReady && window.mpvBridge) return Promise.resolve();
  if (_connectingPromise) return _connectingPromise;

  _connectingPromise = new Promise((resolve) => {
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
          onIsPlayingChanged: null,
          onNativeSubChanged: null,
          onNativeAudioChanged: null,
          onNativeVolumeChanged: null,
          onNativeSubSizeChanged: null,
          onToggleSourcePanel: null,
          onBackRequested: null,
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
          mpvPaused = p;
          if (window.mpvEvents?.onPauseChanged) window.mpvEvents.onPauseChanged(p);
        });
        bridge.isPlayingChanged.connect((p: boolean) => {
          if (window.mpvEvents?.onIsPlayingChanged) window.mpvEvents.onIsPlayingChanged(p);
        });
        bridge.nativeSubChanged.connect((mpvId: number) => {
          if (window.mpvEvents?.onNativeSubChanged) window.mpvEvents.onNativeSubChanged(mpvId);
        });
        bridge.nativeAudioChanged.connect((mpvId: number) => {
          if (window.mpvEvents?.onNativeAudioChanged) window.mpvEvents.onNativeAudioChanged(mpvId);
        });
        bridge.nativeVolumeChanged.connect((percent: number) => {
          if (window.mpvEvents?.onNativeVolumeChanged) window.mpvEvents.onNativeVolumeChanged(percent);
        });
        bridge.nativeSubSizeChanged.connect((size: number) => {
          if (window.mpvEvents?.onNativeSubSizeChanged) window.mpvEvents.onNativeSubSizeChanged(size);
        });
        bridge.toggleSourcePanel.connect(() => {
          if (window.mpvEvents?.onToggleSourcePanel) window.mpvEvents.onToggleSourcePanel();
        });
        bridge.backRequested.connect(() => {
          if (window.mpvEvents?.onBackRequested) window.mpvEvents.onBackRequested();
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
  return _connectingPromise;
}

// ── State (tracked via QWebChannel signals) ────────────────────────

export let mpvPaused = false;

// ── Commands (send to mpv) ──────────────────────────────────────────

export function mpvTogglePause(): void {
  if (mpvPaused) window.mpvBridge?.resume();
  else window.mpvBridge?.pause();
}

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

export function mpvSetSubFontSize(size: number): void {
  window.mpvBridge?.setProperty("sub-font-size", size);
}

export function mpvStop(): void {
  window.mpvBridge?.stop();
}

/** Stop mpv and wait for confirmation that playback has fully stopped. */
export function mpvStopAndWait(): Promise<void> {
  return new Promise((resolve) => {
    if (!window.mpvBridge) { resolve(); return; }
    const prev = window.mpvEvents?.onIsPlayingChanged ?? null;
    if (window.mpvEvents) {
      window.mpvEvents.onIsPlayingChanged = (playing: boolean) => {
        if (!playing) {
          // Restore previous handler and resolve
          if (window.mpvEvents) window.mpvEvents.onIsPlayingChanged = prev;
          resolve();
        }
      };
    }
    window.mpvBridge.stop();
    // Safety timeout in case signal never arrives
    setTimeout(() => {
      if (window.mpvEvents) window.mpvEvents.onIsPlayingChanged = prev;
      resolve();
    }, 2000);
  });
}

export function mpvSetTitle(title: string): void {
  (window.mpvBridge as any)?.setTitle?.(title);
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

export function onNativeSubChanged(cb: (mpvId: number) => void): void {
  if (window.mpvEvents) window.mpvEvents.onNativeSubChanged = cb;
}

export function onNativeAudioChanged(cb: (mpvId: number) => void): void {
  if (window.mpvEvents) window.mpvEvents.onNativeAudioChanged = cb;
}

export function onNativeVolumeChanged(cb: (percent: number) => void): void {
  if (window.mpvEvents) window.mpvEvents.onNativeVolumeChanged = cb;
}

export function onNativeSubSizeChanged(cb: (size: number) => void): void {
  if (window.mpvEvents) window.mpvEvents.onNativeSubSizeChanged = cb;
}

export function onBackRequested(cb: () => void): void {
  if (window.mpvEvents) window.mpvEvents.onBackRequested = cb;
}

export function onToggleSourcePanel(cb: () => void): void {
  if (window.mpvEvents) window.mpvEvents.onToggleSourcePanel = cb;
}

export function mpvSetSourceCount(count: number): void {
  (window.mpvBridge as any)?.setSourceCount?.(count);
}

export function mpvNotifySourcePanel(open: boolean): void {
  (window.mpvBridge as any)?.notifySourcePanel?.(open);
}

export function mpvSetPoster(url: string): void {
  (window.mpvBridge as any)?.setPoster?.(url);
}

export function mpvSetLoadingStatus(text: string): void {
  (window.mpvBridge as any)?.setLoadingStatus?.(text);
}

export function mpvSetLoading(loading: boolean): void {
  (window.mpvBridge as any)?.setLoading?.(loading);
}

export function mpvSetSlowWarning(show: boolean, hasAlternatives: boolean): void {
  (window.mpvBridge as any)?.setSlowWarning?.(show, hasAlternatives);
}
