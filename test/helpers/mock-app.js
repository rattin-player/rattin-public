import { EventEmitter } from "node:events";
import { createApp } from "../../server.js";

/**
 * Create a minimal mock WebTorrent client.
 * Has the same shape the server expects: torrents array, add(), destroy(), etc.
 */
export function mockClient() {
  const emitter = new EventEmitter();
  emitter.torrents = [];
  emitter.add = (magnetURI, opts, cb) => {
    const torrent = new EventEmitter();
    torrent.infoHash = "mock-" + Math.random().toString(36).slice(2, 10);
    torrent.magnetURI = magnetURI;
    torrent.name = "Mock Torrent";
    torrent.files = [];
    torrent.pieces = [];
    torrent.progress = 0;
    torrent.downloadSpeed = 0;
    torrent.uploadSpeed = 0;
    torrent.numPeers = 0;
    torrent.path = "/tmp/rattin";
    torrent.ready = true;
    torrent.done = false;
    torrent.paused = false;
    torrent.destroyed = false;
    torrent.pause = () => { torrent.paused = true; };
    torrent.resume = () => { torrent.paused = false; };
    torrent.deselect = () => {};
    torrent.select = () => {};
    torrent.critical = () => {};
    torrent.destroy = (opts2, cb2) => {
      const callback = typeof opts2 === "function" ? opts2 : cb2;
      torrent.destroyed = true;
      emitter.torrents = emitter.torrents.filter((t) => t !== torrent);
      if (callback) callback();
    };
    emitter.torrents.push(torrent);
    if (typeof cb === "function") cb(torrent);
    return torrent;
  };
  emitter.destroy = (cb) => {
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
export function createTestApp(overrides = {}) {
  const client = overrides.client || mockClient();
  return createApp({ client, ...overrides });
}

/**
 * Start the Express app on a random port.
 * Returns { baseUrl, server, close, ...appResult }.
 */
export function startTestServer(overrides = {}) {
  return new Promise((resolve, reject) => {
    const appResult = createTestApp(overrides);
    const server = appResult.app.listen(0, () => {
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        baseUrl,
        server,
        close: () => {
          // Stop the idle tracker to prevent process from hanging
          if (appResult.idleTracker) appResult.idleTracker.stop();
          return new Promise((res) => {
            // Stop accepting new connections
            server.close(res);
            // Force-close existing keep-alive/SSE connections
            if (server.closeAllConnections) server.closeAllConnections();
          });
        },
        ...appResult,
      });
    });
    server.on("error", reject);
  });
}
