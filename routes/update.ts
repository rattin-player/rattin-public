import type { Express, Request, Response } from "express";
import type { ServerContext } from "../lib/types.js";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  published_at: string;
  prerelease: boolean;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
}

interface UpdateInfo {
  available: boolean;
  current: string;
  latest: string;
  releases: Array<{
    version: string;
    name: string;
    body: string;
    url: string;
    date: string;
    assets: Array<{ name: string; url: string; size: number }>;
  }>;
}

// Cache the result for 1 hour to avoid hammering GitHub API
let cached: { data: UpdateInfo; ts: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000;

function parseVersion(tag: string): number[] {
  return tag.replace(/^v/, "").split("-")[0].split(".").map(Number);
}

function isNewer(a: string, b: string): boolean {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if ((va[i] || 0) > (vb[i] || 0)) return true;
    if ((va[i] || 0) < (vb[i] || 0)) return false;
  }
  return false;
}

// In dev, package.json is one level up from routes/; when esbuild bundles
// into app/server.js it sits next to package.json, so try both locations.
const _updateDir = path.dirname(fileURLToPath(import.meta.url));
const _pkgPath = existsSync(path.join(_updateDir, "package.json"))
  ? path.join(_updateDir, "package.json")
  : path.join(_updateDir, "..", "package.json");
const CURRENT_VERSION = JSON.parse(readFileSync(_pkgPath, "utf8")).version as string;

export default function updateRoutes(app: Express, ctx: ServerContext): void {
  const { log } = ctx;

  app.get("/api/update/check", async (_req: Request, res: Response) => {
    const current = CURRENT_VERSION;

    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      res.json(cached.data);
      return;
    }

    try {
      const resp = await fetch(
        "https://api.github.com/repos/rattin-player/rattin-public/releases?per_page=20",
        { headers: { Accept: "application/vnd.github+json", "User-Agent": "rattin" } },
      );
      if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);

      const allReleases: GitHubRelease[] = await resp.json();

      // Filter: only stable releases newer than current, sorted newest-first
      const newerReleases = allReleases
        .filter((r) => !r.prerelease && isNewer(r.tag_name, current))
        .sort((a, b) => {
          // Newest first
          const va = parseVersion(a.tag_name);
          const vb = parseVersion(b.tag_name);
          for (let i = 0; i < 3; i++) {
            if ((vb[i] || 0) !== (va[i] || 0)) return (vb[i] || 0) - (va[i] || 0);
          }
          return 0;
        });

      const latest = newerReleases.length > 0
        ? newerReleases[0].tag_name.replace(/^v/, "")
        : current;

      const data: UpdateInfo = {
        available: newerReleases.length > 0,
        current,
        latest,
        releases: newerReleases.map((r) => ({
          version: r.tag_name.replace(/^v/, ""),
          name: r.name || r.tag_name,
          body: r.body || "",
          url: r.html_url,
          date: r.published_at,
          assets: r.assets.map((a) => ({
            name: a.name,
            url: a.browser_download_url,
            size: a.size,
          })),
        })),
      };

      cached = { data, ts: Date.now() };
      res.json(data);
    } catch (err) {
      log("warn", "Update check failed", err);
      res.json({ available: false, current, latest: current, releases: [] });
    }
  });
}
