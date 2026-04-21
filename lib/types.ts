// lib/types.ts
// Shared type definitions for the Rattin backend.

import type { ChildProcess } from "child_process";
import type { Request, Response, NextFunction } from "express";
import type { Readable } from "stream";
import type { WatchHistory } from "./storage/watch-history.js";
import type { SavedList } from "./storage/saved-list.js";

// ── Log ───────────────────────────────────────────────────────────────

export type LogLevel = "info" | "warn" | "err";
export type LogFn = (level: LogLevel, msg: string, data?: unknown) => void;

// ── WebTorrent (minimal interfaces for what the server uses) ─────────

export interface TorrentBitfield {
  get(index: number): boolean;
}

export interface TorrentFile {
  name: string;
  path: string;
  length: number;
  downloaded: number;
  offset: number;
  /** Private API — exposed via torrent-compat */
  _endPiece: number;
  select(): void;
  deselect(): void;
  createReadStream(opts?: { start?: number; end?: number }): Readable;
}

export interface Torrent {
  infoHash: string;
  name: string;
  pieceLength: number;
  bitfield: TorrentBitfield;
  files: TorrentFile[];
  paused: boolean;
  ready: boolean;
  magnetURI: string;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  downloaded: number;
  uploaded: number;
  length: number;
  pause(): void;
  resume(): void;
  destroy(opts?: { destroyStore?: boolean }): void;
  select(start: number, end: number, priority?: number): void;
  deselect(start: number, end: number): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface TorrentClient {
  torrents: Torrent[];
  add(magnetURI: string, opts?: Record<string, unknown>, callback?: (torrent: Torrent) => void): Torrent;
  remove(torrentId: string, opts?: Record<string, unknown>, callback?: (err?: Error) => void): void;
  seed(input: unknown, opts?: Record<string, unknown>, callback?: (torrent: Torrent) => void): Torrent;
  on(event: string, listener: (...args: unknown[]) => void): void;
  destroy(callback?: (err?: Error) => void): void;
}

// ── Seek Index ────────────────────────────────────────────────────────

export interface SeekEntry {
  time: number;
  offset: number;
}

// ── Transcode ─────────────────────────────────────────────────────────

export interface TranscodeJob {
  outputPath: string;
  done: boolean;
  error: string | null;
  process: ChildProcess | null;
}

export interface ProbeResult {
  valid: boolean;
  format?: string;
  streams?: number;
  duration?: number;
  videoCodec?: string;
  audioCodec?: string;
  reason?: string;
}

export interface TranscodeArgs {
  input: string;
  useStdin: boolean;
  seekTo: number;
  audioStreamIdx: number | null;
  videoCodec: string | undefined;
  needsDownscale: boolean;
  isRetry: boolean;
}

export interface LiveTranscodeOpts {
  inputPath: string;
  useStdin: boolean;
  createInputStream?: () => Readable;
  seekTo: number;
  audioStreamIdx: number | null;
  streamKey: string | null;
}

export interface ActiveTranscode {
  ffmpeg: ChildProcess;
  torrentStream: Readable | null;
  cleanup: () => void;
}

// ── Completed Files ───────────────────────────────────────────────────

export interface CompletedFile {
  path: string;
  size: number;
  name: string;
}

// ── Stream Tracker ────────────────────────────────────────────────────

export interface StreamEntry {
  count: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// ── Availability Cache ────────────────────────────────────────────────

export interface AvailEntry {
  available: boolean;
  ts: number;
}

// ── Intro Detection ───────────────────────────────────────────────────

export interface IntroEntry {
  intro_start: number;
  intro_end: number;
  source?: string;
}

export interface CrossCorrelationResult {
  offsetA: number;
  offsetB: number;
  duration: number;
  score: number;
}

export interface FingerprintResult {
  fingerprint: number[];
  duration: number;
}

// ── Remote Control ────────────────────────────────────────────────────

export interface RCClient {
  end(): void;
}

export interface RCSession {
  playerClient: RCClient | null;
  remoteClients: RCClient[];
  playbackState: PlaybackState | null;
  lastActivity: number;
  authToken?: string;
  pairingCode?: string;
  bingeMode: {
    enabled: boolean;
    capabilities: BingeCapabilities | null;
    persistedTracks: PersistedTracks;
    diagnostics: BingeDiagnostics | null;
  };
}

// ── Playback State (shared between frontend and backend RC) ──────────

export interface PlaybackState {
  playing?: boolean;
  currentTime?: number;
  duration?: number;
  title?: string;
  poster?: string;
  volume?: number;
  muted?: boolean;
}

// ── Binge Mode ────────────────────────────────────────────────────────

export type MarkerSource =
  | "chapter markers"
  | "AniSkip · duration OK"
  | "AniSkip · duration mismatch"
  | "IntroDB · ok"
  | "learned outro offset"
  | "no signal — advance on EOF"
  | "no chapter data"
  | "no AniSkip data"
  | "no IntroDB data"
  | "bridge missing chapter support";

export interface BingeCapabilities {
  autoSkipIntro: { enabled: boolean; source: MarkerSource };
  autoSkipCredits: { enabled: boolean; source: MarkerSource; sampleCount?: number };
  persistTracks: { enabled: boolean };
  autoAdvance: { enabled: boolean; viaEOF: boolean };
  prefetch: { enabled: boolean; via: "debrid cache" | "torrent pieces" | null };
}

export interface PersistedTracks {
  audio: { lang: string; title: string } | null;
  subtitles: { lang: string; title: string } | null;
}

export type CoordinatorState = "idle" | "prefetching" | "armed" | "advancing" | "stopped" | "finale";

export type BingeEventKind =
  | "episode-start"
  | "intro-skip"
  | "prefetch-fire"
  | "prefetch-ok"
  | "prefetch-error"
  | "armed"
  | "advance-start"
  | "advance-ready"
  | "advance-timeout"
  | "end-of-series"
  | "state"
  | "stop";

export interface BingeEvent {
  at: number;               // epoch ms
  kind: BingeEventKind;
  t?: number;               // playback time when event fired (seconds)
  detail?: string;
}

export interface BingeDiagnostics {
  state: CoordinatorState;
  duration: number;         // current episode duration (seconds)
  markers: {
    introStart: number | null;
    introEnd: number | null;
    outroStart: number | null;
    introSource: MarkerSource;
    outroSource: MarkerSource;
  } | null;
  signals: {
    chapters: { count: number; intro: { start: number; end: number } | null; outro: { start: number } | null } | null;
    aniskip: {
      op: { start: number; end: number } | null;
      ed: { start: number; end: number } | null;
      durationMatch: boolean;
      resolution: {
        malId: number;
        jikanTitle: string;
        jikanQuery: string;
        aniskipUrl: string;
        seasonSpecific: boolean;
      } | null;
    } | null;
    introdb: {
      imdbId: string;
      intro: { start: number; end: number; confidence: number; submissionCount: number } | null;
      outro: { start: number; end: number; confidence: number; submissionCount: number } | null;
    } | null;
    learnedOutro: { sampleCount: number; offset: number } | null;
  };
  prefetch: {
    threshold: number;      // 0..1 fraction of duration
    firedAtTime: number | null;   // playback time when fired
    firedAtEpoch: number | null;  // epoch ms
    resolved: "ok" | "error" | null;
    error?: string;
    ready: boolean;
  };
  nextAction: {
    kind: "skip-intro" | "prefetch" | "advance" | "end-of-series";
    atTime: number | null;  // seconds (scheduled playback time), null if immediate
    reason: string;
  } | null;
  events: BingeEvent[];     // capped ring buffer (most recent last)
}

export interface LearnedOffsetSample {
  offset: number;
  at: string;
  season: number;
  episode: number;
}

export interface SubTrack {
  index: number;
  label: string;
  language?: string;
}

export interface AudioTrack {
  index: number;
  label: string;
  language?: string;
}

export interface ActiveStream {
  infoHash: string;
  fileIndex: number;
  name: string;
}

// ── Torrent Search / Scoring ──────────────────────────────────────────

export interface TorrentResult {
  name: string;
  seeders: number;
  leechers?: number;
  size?: number;
  magnet?: string;
  hash?: string;
  provider?: string;
}

export interface ScoredTorrent extends TorrentResult {
  score: number;
  tags: string[];
}

// ── Cache ─────────────────────────────────────────────────────────────

export interface StaleResult<T> {
  value: T | undefined;
  stale: boolean;
}

export interface CacheStats {
  entries: number;
  maxEntries: number;
}

// ── Torrent Caches Registry ───────────────────────────────────────────

export type CacheKeyStyle = "hash:index" | "hash" | "path";

export interface CacheRegistration {
  name: string;
  map: Map<string, unknown> | Set<string>;
  keyStyle: CacheKeyStyle;
}

// ── Idle Tracker ──────────────────────────────────────────────────────

export interface IdleTrackerOpts {
  onSoftIdle?: () => void;
  onHardIdle?: () => void;
  logFn?: LogFn;
}

export interface IdleTracker {
  touch(): void;
  idleDuration(): number;
  check(): void;
  start(): void;
  stop(): void;
  middleware(req: Request, res: Response, next: NextFunction): void;
}

// ── Server Context ────────────────────────────────────────────────────

export interface ServerContext {
  client: TorrentClient;
  DOWNLOAD_PATH: string;
  TRANSCODE_PATH: string;
  durationCache: Map<string, number>;
  seekIndexCache: Map<string, SeekEntry[]>;
  seekIndexPending: Set<string>;
  activeFiles: Map<string, Set<number>>;
  completedFiles: Map<string, CompletedFile>;
  streamTracker: Map<string, StreamEntry>;
  activeTranscodes: Map<string, ActiveTranscode>;
  availabilityCache: Map<string, AvailEntry>;
  AVAIL_TTL: number;
  introCache: Map<string, IntroEntry>;
  probeCache: Map<string, ProbeResult>;
  pcAuthToken: string;
  rcSessions: Map<string, RCSession>;
  watchHistory: WatchHistory;
  savedList: SavedList;
  log: LogFn;
  diskPath(torrent: Torrent, file: TorrentFile): string;
  isFileComplete(torrent: Torrent, file: TorrentFile): boolean;
  cleanupTorrentCaches(infoHash: string, torrent?: Torrent): void;
  trackStreamOpen(infoHash: string): void;
  trackStreamClose(infoHash: string): void;
  streamTracking(req: Request, res: Response, next: NextFunction): void;
  initClient(): TorrentClient;
}
