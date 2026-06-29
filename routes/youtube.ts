import type { Express, Request, Response } from "express";
import type { ServerContext } from "../lib/types.js";

interface YoutubeResult {
  videoId: string;
  title: string;
  thumbnail: string;
  channelTitle: string;
  duration: string;
  viewCount: number;
}

function parseViewCount(text: string): number {
  if (!text) return 0;
  const cleaned = text.replace(/,/g, "").replace(/ views?/i, "").trim();
  if (/^\d+$/.test(cleaned)) return parseInt(cleaned);
  const match = cleaned.match(/^([\d.]+)([KMB])$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === "K") return Math.round(num * 1000);
  if (unit === "M") return Math.round(num * 1000000);
  if (unit === "B") return Math.round(num * 1000000000);
  return 0;
}

export default function youtubeRoutes(app: Express, ctx: ServerContext): void {
  const { log } = ctx;

  app.get("/api/youtube/search", async (req: Request, res: Response) => {
    const q = (req.query.q as string) || "";
    if (!q.trim()) return res.json({ results: [] });

    try {
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Rattin/3.0)",
          "Accept-Language": "en-US",
        },
        signal: AbortSignal.timeout(12000),
      });

      if (!resp.ok) {
        log("warn", `YouTube search returned ${resp.status}`);
        return res.json({ results: [] });
      }

      const html = await resp.text();

      // Extract ytInitialData JSON blob. Match to </script> boundary —
      // YouTube always emits it right after the data, and it's reliable
      // even when JSON string values contain "};"
      const match = html.match(/var ytInitialData\s*=\s*(\{.*?\})\s*;\s*<\/script>/s);
      if (!match) {
        log("warn", "ytInitialData not found in YouTube response");
        return res.json({ results: [] });
      }

      let data: any;
      try {
        data = JSON.parse(match[1]);
      } catch {
        log("warn", "ytInitialData JSON parse failed");
        return res.json({ results: [] });
      }
      const contents =
        data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.contents;

      if (!contents) return res.json({ results: [] });

      const results: YoutubeResult[] = [];

      for (const section of contents) {
        const items = section?.itemSectionRenderer?.contents;
        if (!items) continue;
        for (const item of items) {
          const vr = item?.videoRenderer;
          if (!vr || vr.upcomingEventData) continue;

          const thumb =
            vr.thumbnail?.thumbnails?.slice(-1)[0]?.url || "";
          const viewText = vr.viewCountText?.simpleText
            || vr.viewCountText?.runs?.[0]?.text || "";
          results.push({
            videoId: vr.videoId || "",
            title: vr.title?.runs?.[0]?.text || "",
            thumbnail: thumb.startsWith("//") ? `https:${thumb}` : thumb,
            channelTitle: vr.ownerText?.runs?.[0]?.text || "",
            duration: vr.lengthText?.simpleText || "",
            viewCount: parseViewCount(viewText),
          });

          if (results.length >= 20) break;
        }
        if (results.length >= 20) break;
      }

      res.json({ results });
    } catch (e) {
      log("err", `YouTube search failed: ${(e as Error).message}`);
      res.json({ results: [] });
    }
  });
}
