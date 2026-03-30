import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../../server.js";
import type { TorrentClient } from "../../lib/types.js";

interface MockTorrent extends EventEmitter {
  infoHash: string;
  magnetURI: string;
  name: string;
  files: unknown[];
  pieces: unknown[];
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  path: string;
  ready: boolean;
  done: boolean;
  paused: boolean;
  destroyed: boolean;
  pause(): void;
  resume(): void;
  deselect(): void;
  select(): void;
  critical(): void;
  destroy(opts?: unknown, cb?: () => void): void;
}

export interface MockClient extends EventEmitter {
  torrents: Array<MockTorrent | Record<string, unknown>>;
  add(magnetURI: string, opts: unknown, cb?: (torrent: MockTorrent) => void): MockTorrent;
  destroy(cb?: () => void): void;
  pause(): void;
  resume(): void;
}

type AppResult = ReturnType<typeof createApp>;

export interface TestServerResult extends AppResult {
  baseUrl: string;
  server: import("http").Server;
  close: () => Promise<void>;
  client: TorrentClient;
}

/**
 * Create a minimal mock WebTorrent client.
 * Has the same shape the server expects: torrents array, add(), destroy(), etc.
 */
export function mockClient(): MockClient {
  const emitter = new EventEmitter() as MockClient;
  emitter.torrents = [];
  emitter.add = (magnetURI: string, _opts: unknown, cb?: (torrent: MockTorrent) => void): MockTorrent => {
    const torrent = Object.assign(new EventEmitter(), {
      infoHash: "mock-" + Math.random().toString(36).slice(2, 10),
      magnetURI,
      name: "Mock Torrent",
      files: [] as unknown[],
      pieces: [] as unknown[],
      progress: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      path: "/tmp/rattin",
      ready: true,
      done: false,
      paused: false,
      destroyed: false,
      pause(this: MockTorrent) { this.paused = true; },
      resume(this: MockTorrent) { this.paused = false; },
      deselect() {},
      select() {},
      critical() {},
    }) as MockTorrent;
    torrent.destroy = (opts2?: unknown, cb2?: () => void) => {
      const callback = typeof opts2 === "function" ? opts2 as () => void : cb2;
      torrent.destroyed = true;
      emitter.torrents = emitter.torrents.filter((t) => t !== torrent);
      if (callback) callback();
    };
    emitter.torrents.push(torrent);
    if (typeof cb === "function") cb(torrent);
    return torrent;
  };
  emitter.destroy = (cb?: () => void) => {
    emitter.torrents = [];
    if (cb) cb();
  };
  emitter.pause = () => {};
  emitter.resume = () => {};
  return emitter;
}

/**
 * Create an Express app with a mock WebTorrent client.
 * Returns everything createApp returns.
 */
export function createTestApp(overrides: Record<string, unknown> = {}): AppResult {
  const client = (overrides.client || mockClient()) as TorrentClient;
  return createApp({ client, ...overrides });
}

/**
 * Start the Express app on a random port.
 * Returns { baseUrl, server, close, ...appResult }.
 */
export function startTestServer(overrides: Record<string, unknown> = {}): Promise<TestServerResult> {
  return new Promise((resolve, reject) => {
    const appResult = createTestApp(overrides);
    const server = appResult.app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        baseUrl,
        server,
        close: () => {
          // Stop the idle tracker to prevent process from hanging
          if (appResult.idleTracker) appResult.idleTracker.stop();
          return new Promise<void>((res) => {
            // Stop accepting new connections
            server.close(() => res());
            // Force-close existing keep-alive/SSE connections
            if (server.closeAllConnections) server.closeAllConnections();
          });
        },
        ...appResult,
      } as TestServerResult);
    });
    server.on("error", reject);
  });
}
