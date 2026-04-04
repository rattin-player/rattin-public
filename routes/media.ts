import path from "path";
import fs from "fs";
import { createReadStream, statSync } from "fs";
import { spawn } from "child_process";
import type { Express, Request, Response } from "express";
import { jobKey } from "../lib/cache/torrent-caches.js";
import { getFileOffset } from "../lib/torrent/torrent-compat.js";
import { hasPiece } from "../lib/torrent/torrent-compat.js";
import { VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS, srtToVtt } from "../lib/media/media-utils.js";
import { detectIntro, lookupExternal } from "../lib/media/intro-detect.js";
import type { ServerContext, Torrent } from "../lib/types.js";
import { getActiveDebridUrl } from "../lib/torrent/debrid.js";

export default function mediaRoutes(app: Express, ctx: ServerContext): void {
  const {
    log, diskPath, isFileComplete, DOWNLOAD_PATH,
    durationCache, introCache,
  } = ctx;
  // Access ctx.client via getter (not destructured) so deferred init is visible
  const client = () => ctx.client;

  // Duration endpoint - ffprobe the video to get total duration
  app.get("/api/duration/:infoHash/:fileIndex", (req: Request, res: Response) => {
    const { infoHash, fileIndex } = req.params as Record<string, string>;
    const cacheKey = `${infoHash}:${fileIndex}`;
    if (durationCache.has(cacheKey)) {
      return res.json({ duration: durationCache.get(cacheKey) });
    }

    const torrent = client().torrents.find((t) => t.infoHash === infoHash);
    let filePath: string;

    if (torrent) {
      const file = torrent.files[parseInt(fileIndex, 10)];
      if (!file) return res.status(404).json({ error: "File not found" });
      filePath = diskPath(torrent, file);
      try { statSync(filePath); } catch {
        return res.json({ duration: null });
      }
    } else {
      const debridUrl = getActiveDebridUrl(infoHash, parseInt(fileIndex, 10));
      if (!debridUrl) return res.status(404).json({ error: "Torrent not found" });
      filePath = debridUrl;
    }

    const probe = spawn("ffprobe", [
      "-v", "quiet", "-print_format", "json",
      "-show_format",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    probe.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    probe.on("close", (code: number | null) => {
      if (code !== 0) return res.json({ duration: null });
      try {
        const data = JSON.parse(out);
        const dur = parseFloat(data.format?.duration);
        if (dur && isFinite(dur)) {
          durationCache.set(cacheKey, dur);
          return res.json({ duration: dur });
        }
      } catch {}
      res.json({ duration: null });
    });
  });

  // Subtitle endpoint - converts any subtitle format to WebVTT
  app.get("/api/subtitle/:infoHash/:fileIndex", (req: Request, res: Response) => {
    const { infoHash, fileIndex } = req.params as Record<string, string>;
    const torrent = client().torrents.find((t) => t.infoHash === infoHash);
    if (!torrent) return res.status(404).json({ error: "Torrent not found" });

    const file = torrent.files[parseInt(fileIndex, 10)];
    if (!file) return res.status(404).json({ error: "File not found" });

    const ext = path.extname(file.name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.includes(ext)) {
      return res.status(400).json({ error: "Not a subtitle file" });
    }

    const complete = isFileComplete(torrent, file);
    const filePath = diskPath(torrent, file);
    const offset = parseFloat(req.query.offset as string) || 0;

    // If complete on disk, serve from disk (fast path)
    if (complete) {
      if (offset > 0 || (ext !== ".srt" && ext !== ".vtt")) {
        log("info", "Converting subtitle via ffmpeg", { file: file.name, ext, offset });
        const args = [
          ...(offset > 0 ? ["-ss", String(offset)] : []),
          "-i", filePath,
          "-f", "webvtt",
          "-v", "warning",
          "pipe:1",
        ];
        const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
        res.setHeader("Content-Type", "text/vtt; charset=utf-8");
        ffmpeg.stdout!.pipe(res);
        ffmpeg.stderr!.on("data", (d: Buffer) => log("warn", "Subtitle ffmpeg: " + d.toString().trim()));
        ffmpeg.on("close", (code: number | null) => {
          if (code !== 0) log("err", "Subtitle conversion failed", { file: file.name, code });
        });
        res.on("close", () => ffmpeg.kill());
        return;
      }

      if (ext === ".vtt") {
        res.setHeader("Content-Type", "text/vtt; charset=utf-8");
        return createReadStream(filePath).pipe(res);
      }

      if (ext === ".srt") {
        res.setHeader("Content-Type", "text/vtt; charset=utf-8");
        try {
          const srtContent = fs.readFileSync(filePath, "utf-8");
          return res.send(srtToVtt(srtContent));
        } catch (err) {
          log("err", "SRT read failed, falling back to stream", { error: (err as Error).message });
        }
      }
    }

    // Not complete or disk read failed — stream directly from WebTorrent.
    // Select the file to trigger download of its pieces.
    try { file.deselect(); file.select(); } catch {}
    log("info", "Streaming subtitle from torrent", { file: file.name, complete });

    const chunks: Buffer[] = [];
    const stream = file.createReadStream();
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      if (ext === ".vtt") return res.send(raw);
      if (ext === ".srt") return res.send(srtToVtt(raw));
      // Other formats: pipe through ffmpeg from buffer
      const ffmpeg = spawn("ffmpeg", [
        ...(offset > 0 ? ["-ss", String(offset)] : []),
        "-i", "pipe:0", "-f", "webvtt", "-v", "warning", "pipe:1",
      ], { stdio: ["pipe", "pipe", "pipe"] });
      ffmpeg.stdin!.end(Buffer.concat(chunks));
      ffmpeg.stdout!.pipe(res);
      ffmpeg.stderr!.on("data", (d: Buffer) => log("warn", "Subtitle ffmpeg: " + d.toString().trim()));
      ffmpeg.on("close", (code: number | null) => {
        if (code !== 0) log("err", "Subtitle conversion failed", { file: file.name, code });
      });
      res.on("close", () => ffmpeg.kill());
    });
    stream.on("error", (err: Error) => {
      log("err", "Subtitle stream error", { file: file.name, error: err.message });
      if (!res.headersSent) {
        res.setHeader("Cache-Control", "no-store");
        res.status(500).json({ error: "Subtitle stream failed" });
      }
    });
  });


  // Probe embedded subtitle streams in a video file
  app.get("/api/subtitles/:infoHash/:fileIndex", (req: Request, res: Response) => {
    res.removeHeader("ETag");
    res.setHeader("Cache-Control", "no-store");
    const { infoHash, fileIndex } = req.params as Record<string, string>;
    const torrent = client().torrents.find((t) => t.infoHash === infoHash);

    let filePath: string;
    let complete: boolean;

    if (torrent) {
      const file = torrent.files[parseInt(fileIndex, 10)];
      if (!file) return res.status(404).json({ error: "File not found" });
      complete = isFileComplete(torrent, file);
      filePath = diskPath(torrent, file);
      try { statSync(filePath); } catch {
        return res.json({ tracks: [], complete: false });
      }
    } else {
      // Debrid fallback: probe the remote URL directly (ffprobe supports HTTPS)
      const debridUrl = getActiveDebridUrl(infoHash, parseInt(fileIndex, 10));
      if (!debridUrl) return res.status(404).json({ error: "Torrent not found" });
      filePath = debridUrl;
      complete = true;
    }

    // Use ffprobe to list subtitle streams
    const probe = spawn("ffprobe", [
      "-v", "quiet", "-print_format", "json",
      "-show_streams", "-select_streams", "s",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    probe.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    probe.on("close", (code: number | null) => {
      if (code !== 0) return res.json({ tracks: [], complete });
      try {
        const data = JSON.parse(out);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tracks = (data.streams || []).map((s: any) => ({
          streamIndex: s.index,
          lang: s.tags?.language || null,
          title: s.tags?.title || null,
          codec: s.codec_name,
        }));
        log("info", "Subtitle probe", { path: filePath.slice(-60), tracks: tracks.length, complete });
        res.json({ tracks, complete });
      } catch {
        res.json({ tracks: [], complete });
      }
    });
  });

  // List embedded audio streams
  app.get("/api/audio-tracks/:infoHash/:fileIndex", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const { infoHash, fileIndex } = req.params as Record<string, string>;
    const torrent = client().torrents.find((t) => t.infoHash === infoHash);

    let filePath: string;
    let complete: boolean;

    if (torrent) {
      const file = torrent.files[parseInt(fileIndex, 10)];
      if (!file) return res.status(404).json({ error: "File not found" });
      complete = isFileComplete(torrent, file);
      filePath = diskPath(torrent, file);
      try { statSync(filePath); } catch {
        return res.json({ tracks: [], complete: false });
      }
    } else {
      const debridUrl = getActiveDebridUrl(infoHash, parseInt(fileIndex, 10));
      if (!debridUrl) return res.status(404).json({ error: "Torrent not found" });
      filePath = debridUrl;
      complete = true;
    }

    const probe = spawn("ffprobe", [
      "-v", "quiet", "-print_format", "json",
      "-show_streams", "-select_streams", "a",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    probe.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    probe.on("close", (code: number | null) => {
      if (code !== 0) return res.json({ tracks: [], complete });
      try {
        const data = JSON.parse(out);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tracks = (data.streams || []).map((s: any) => ({
          streamIndex: s.index,
          lang: s.tags?.language || null,
          title: s.tags?.title || null,
          codec: s.codec_name,
          channels: s.channels || 0,
        }));
        log("info", "Audio track probe", { path: filePath.slice(-60), tracks: tracks.length, complete });
        res.json({ tracks, complete });
      } catch {
        res.json({ tracks: [], complete });
      }
    });
  });

  // Intro detection — returns skip timestamps for TV episode intros
  app.get("/api/intro/:infoHash/:fileIndex", async (req: Request, res: Response) => {
    const { infoHash, fileIndex } = req.params as Record<string, string>;
    res.set("Cache-Control", "no-store");
    const tmdbId = req.query.tmdbId as string | undefined;
    const season = parseInt(req.query.season as string, 10);
    const episode = parseInt(req.query.episode as string, 10);
    const title = (req.query.title as string) || "";

    // Check cache first (works even if torrent is gone)
    if (tmdbId && season) {
      const cacheKey = `${tmdbId}:${season}`;
      const cached = introCache.get(cacheKey);
      if (cached && cached.source === "fingerprint") {
        return res.json({ detected: true, ...cached });
      }
    }

    // Collect sibling video files for fingerprinting
    const siblingPaths: string[] = [];
    let currentPath: string | null = null;
    const torrent = client().torrents.find((t) => t.infoHash === infoHash);

    if (torrent) {
      // Torrent is active — scan its file list
      // Only include files where the first ~5 min of data is actually downloaded
      // (WebTorrent pre-allocates full file size, so stat check is unreliable)
      const fileIdx = parseInt(fileIndex, 10);
      const file = torrent.files[fileIdx];
      if (file) currentPath = diskPath(torrent, file);
      const pieceLength = torrent.pieceLength || 262144;
      for (const f of torrent.files) {
        const ext = path.extname(f.name).toLowerCase();
        if (!VIDEO_EXTENSIONS.includes(ext)) continue;
        // Check if the first ~10% of the file has been downloaded (enough for 5 min audio)
        // by verifying the first N pieces are available
        const fileOffset = getFileOffset(f);
        const firstPiece = Math.floor(fileOffset / pieceLength);
        const bytesNeeded = Math.min(f.length * 0.1, 200_000_000); // 10% or 200MB, whichever is less
        const piecesNeeded = Math.ceil(bytesNeeded / pieceLength);
        let hasBeginning = true;
        for (let p = firstPiece; p < firstPiece + piecesNeeded; p++) {
          if (!hasPiece(torrent, p)) { hasBeginning = false; break; }
        }
        if (hasBeginning) {
          const fp = diskPath(torrent, f);
          siblingPaths.push(fp);
        }
      }
    }

    // Also scan the download directory for video files from any torrent
    // This finds episodes that persist on disk after torrent idle-timeout
    // Validate with a quick ffprobe since these may be incomplete downloads
    try {
      for (const dir of fs.readdirSync(DOWNLOAD_PATH)) {
        const dirPath = path.join(DOWNLOAD_PATH, dir);
        try {
          if (!fs.statSync(dirPath).isDirectory()) continue;
          for (const fname of fs.readdirSync(dirPath)) {
            const ext = path.extname(fname).toLowerCase();
            if (!VIDEO_EXTENSIONS.includes(ext)) continue;
            const fp = path.join(dirPath, fname);
            if (siblingPaths.includes(fp)) continue;
            try {
              if (statSync(fp).size > 50_000_000) siblingPaths.push(fp);
            } catch {}
          }
        } catch {}
      }
    } catch {}

    // If we don't have a currentPath from the torrent, try to find the streaming file
    // from the /api/stream endpoint's perspective (it may have been served from disk)
    if (!currentPath && siblingPaths.length > 0) {
      // Use the first file as a fallback — fingerprinting just needs any 2 episodes
      currentPath = siblingPaths[0];
    }

    // Try fingerprint detection if we have 2+ files
    if (siblingPaths.length >= 2) {
      // Pass all siblings (not just 2) so detectIntro can skip corrupt files
      const ordered = currentPath
        ? [currentPath, ...siblingPaths.filter((p) => p !== currentPath)]
        : [...siblingPaths];
      try {
        const result = await detectIntro(ordered);
        if (result) {
          const entry = { intro_start: result.intro_start, intro_end: result.intro_end, source: "fingerprint" as const };
          if (tmdbId && season) introCache.set(`${tmdbId}:${season}`, entry);
          return res.json({ detected: true, ...entry });
        }
      } catch (err) {
        log("warn", "Intro fingerprint detection failed", { error: (err as Error).message });
      }
    }

    // Fallback: AniSkip external lookup
    if (title && episode) {
      const cacheKey = torrent ? jobKey(torrent.infoHash, fileIndex) : null;
      const dur = cacheKey ? (durationCache.get(cacheKey) || 0) : 0;
      try {
        const result = await lookupExternal(title, season || 1, episode, dur);
        if (result) {
          const entry = { intro_start: result.intro_start, intro_end: result.intro_end, source: "external" as const };
          if (tmdbId && season) introCache.set(`${tmdbId}:${season}`, entry);
          return res.json({ detected: true, ...entry });
        }
      } catch (err) {
        log("warn", "AniSkip lookup failed", { error: (err as Error).message });
      }
    }

    res.json({ detected: false });
  });

  // Extract an embedded subtitle stream as WebVTT
  app.get("/api/subtitle-extract/:infoHash/:fileIndex/:streamIndex", (req: Request, res: Response) => {
    const params = req.params as Record<string, string>;
    const torrent = client().torrents.find((t) => t.infoHash === params.infoHash);

    let filePath: string;

    if (torrent) {
      const file = torrent.files[parseInt(params.fileIndex, 10)];
      if (!file) return res.status(404).json({ error: "File not found" });
      filePath = diskPath(torrent, file);
      try { statSync(filePath); } catch {
        return res.status(202).json({ error: "File not on disk yet" });
      }
    } else {
      const debridUrl = getActiveDebridUrl(params.infoHash, parseInt(params.fileIndex, 10));
      if (!debridUrl) return res.status(404).json({ error: "Torrent not found" });
      filePath = debridUrl;
    }

    const streamIdx = parseInt(params.streamIndex, 10);
    if (isNaN(streamIdx) || streamIdx < 0 || streamIdx > 100) {
      return res.status(400).json({ error: "Invalid stream index" });
    }

    const offset = parseFloat(req.query.offset as string) || 0;
    log("info", "Extracting embedded subtitle", { path: filePath.slice(-60), stream: streamIdx, offset });

    const args = [
      ...(offset > 0 ? ["-ss", String(offset)] : []),
      "-i", filePath,
      "-map", `0:${streamIdx}`,
      "-f", "webvtt",
      "-v", "warning",
      "pipe:1",
    ];
    const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    ffmpeg.stdout!.pipe(res);
    ffmpeg.stderr!.on("data", (d: Buffer) => log("warn", "Sub extract: " + d.toString().trim()));
    ffmpeg.on("close", (code: number | null) => {
      if (code !== 0) log("err", "Sub extract failed", { stream: streamIdx, code });
    });
    res.on("close", () => ffmpeg.kill());
  });

}
