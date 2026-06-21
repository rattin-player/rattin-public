// test/fixtures/mock-plugin.js
// Minimal mock plugin for testing the PluginRegistry.
// Implements the same HTTP API as a real plugin:
//   GET  /health
//   POST /search
//   POST /search-batch
//   POST /availability
//
// Env vars:
//   RATTIN_PLUGIN_PORT   - port to listen on (0 = random)
//   RATTIN_PLUGIN_SECRET - auth token; requests without matching Bearer header get 403

import http from "node:http";

const port = parseInt(process.env.RATTIN_PLUGIN_PORT || "0", 10);
const secret = process.env.RATTIN_PLUGIN_SECRET || "";

const server = http.createServer((req, res) => {
  // Auth check
  if (secret && (req.headers.authorization || "") !== `Bearer ${secret}`) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // GET /health
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "mock", name: "Mock Plugin", version: "1.0.0", apiVersion: 1 }));
    return;
  }

  // POST /search
  if (req.method === "POST" && req.url === "/search") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const { query } = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        {
          infoHash: "abc123def456",
          name: `${query}.1080p.WEB-DL`,
          size: 1000000000,
          seeders: 100,
          source: "mock",
        },
      ]));
    });
    return;
  }

  // POST /search-batch
  if (req.method === "POST" && req.url === "/search-batch") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const { queries } = JSON.parse(body || "{}");
      const results = (queries || []).map((q) => [
        {
          infoHash: `hash-${q.query.replace(/\s/g, "").slice(0, 8)}`,
          name: `${q.query}.1080p.WEB-DL`,
          size: 1000000000,
          seeders: 100,
          source: "mock",
        },
      ]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
    });
    return;
  }

  // POST /availability
  if (req.method === "POST" && req.url === "/availability") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const { items } = JSON.parse(body || "{}");
      // Return all items as available
      const available = (items || []).map((_, i) => i);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ available }));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1", () => {
  const actualPort = server.address().port;
  process.stdout.write(JSON.stringify({ port: actualPort }) + "\n");
});
