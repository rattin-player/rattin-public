import path from "path";
import fs from "fs";
import { createReadStream, statSync } from "fs";
import { spawn } from "child_process";
import type { Express, Request, Response } from "express";
import { jobKey } from "../lib/torrent-caches.js";
import { getFileOffset } from "../lib/torrent-compat.js";
import { hasPiece } from "../lib/torrent-compat.js";
import { VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS, srtToVtt } from "../lib/media-utils.js";
import { detectIntro, lookupExternal } from "../lib/intro-detect.js";
import type { ServerContext, Torrent } from "../lib/types.js";

export default function mediaRoutes(app: Express, ctx: ServerContext): void {
  const {
    client, log, diskPath, isFileComplete, DOWNLOAD_PATH,
    durationCache, introCache,
  } = ctx;

  // Duration endpoint - ffprobe the video to get total duration
  app.get("/api/duration/:infoHash/:fileIndex", (req: Request, res: Response) => {
    const { infoHash, fileIndex } = req.params as Record<string, string>;
    const torrent = client.torrents.find((t) => t.infoHash === infoHash);
    if (!torrent) return res.status(404).json({ error: "Torrent not found" });

    const file = torrent.files[parseInt(fileIndex, 10)];
    if (!file) return res.status(404).json({ error: "File not found" });

    const cacheKey = jobKey(torrent.infoHash, fileIndex);
    if (durationCache.has(cacheKey)) {
      return res.json({ duration: durationCache.get(cacheKey) });
    }

    const filePath = diskPath(torrent, file);
    try { statSync(filePath); } catch {
      return res.json({ duration: null });
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
    const torrent = client.torrents.find((t) => t.infoHash === infoHash);
    if (!torrent) return res.status(404).json({ error: "Torrent not found" });

    const file = torrent.files[parseInt(fileIndex, 10)];
    if (!file) return res.status(404).json({ error: "File not found" });

    const ext = path.extname(file.name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.includes(ext)) {
      return res.status(400).json({ error: "Not a subtitle file" });
    }

    const complete = isFileComplete(torrent, file);
    if (!complete) {
      return res.status(202).json({ error: "Subtitle file still downloading" });
    }

    const filePath = diskPath(torrent, file);
    const offset = parseFloat(req.query.offset as string) || 0;

    // For any offset or non-SRT format, use ffmpeg (handles offset via -ss)
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
      res.setHeader("Access-Control-Allow-Origin", "*");
      ffmpeg.stdout!.pipe(res);
      ffmpeg.stderr!.on("data", (d: Buffer) => log("warn", "Subtitle ffmpeg: " + d.toString().trim()));
      ffmpeg.on("close", (code: number | null) => {
        if (code !== 0) log("err", "Subtitle conversion failed", { file: file.name, code });
      });
      res.on("close", () => ffmpeg.kill());
      return;
    }

    // VTT can be served directly (no offset)
    if (ext === ".vtt") {
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return createReadStream(filePath).pipe(res);
    }

    // SRT without offset: simple text conversion
    if (ext === ".srt") {
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      try {
        const srtContent = fs.readFileSync(filePath, "utf-8");
        const vtt = srtToVtt(srtContent);
        return res.send(vtt);
      } catch (err) {
        log("err", "SRT conversion failed, falling back to ffmpeg", { error: (err as Error).message });
      }
    }

    // Fallback: ffmpeg
    const ffmpeg = spawn("ffmpeg", [
      "-i", filePath,
      "-f", "webvtt",
      "-v", "warning",
      "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    ffmpeg.stdout!.pipe(res);

    ffmpeg.stderr!.on("data", (d: Buffer) => log("warn", "Subtitle ffmpeg: " + d.toString().trim()));
    ffmpeg.on("close", (code: number | null) => {
      if (code !== 0) log("err", "Subtitle conversion failed", { file: file.name, code });
    });
    res.on("close", () => ffmpeg.kill());
  });


  // Probe embedded subtitle streams in a video file
  app.get("/api/subtitles/:infoHash/:fileIndex", (req: Request, res: Response) => {
    const { infoHash, fileIndex } = req.params as Record<string, string>;
    const torrent = client.torrents.find((t) => t.infoHash === infoHash);
    if (!torrent) return res.status(404).json({ error: "Torrent not found" });

    const file = torrent.files[parseInt(fileIndex, 10)];
    if (!file) return res.status(404).json({ error: "File not found" });

    // Try to probe even if not complete - ffprobe can read partial files
    const complete = isFileComplete(torrent, file);
    const filePath = diskPath(torrent, file);

    // Check file exists on disk at all
    try { statSync(filePath); } catch {
      return res.json({ tracks: [], complete: false });
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
        log("info", "Subtitle probe", { file: file.name, tracks: tracks.length, complete });
        res.json({ tracks, complete });
      } catch {
        res.json({ tracks: [], complete });
      }
    });
  });

  // List embedded audio streams
  app.get("/api/audio-tracks/:infoHash/:fileIndex", (req: Request, res: Response) => {
    const { infoHash, fileIndex } = req.params as Record<string, string>;
    const torrent = client.torrents.find((t) => t.infoHash === infoHash);
    if (!torrent) return res.status(404).json({ error: "Torrent not found" });

    const file = torrent.files[parseInt(fileIndex, 10)];
    if (!file) return res.status(404).json({ error: "File not found" });

    const complete = isFileComplete(torrent, file);
    const filePath = diskPath(torrent, file);

    try { statSync(filePath); } catch {
      return res.json({ tracks: [], complete: false });
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
        log("info", "Audio track probe", { file: file.name, tracks: tracks.length, complete });
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
    const torrent = client.torrents.find((t) => t.infoHash === infoHash);

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
    const torrent = client.torrents.find((t) => t.infoHash === params.infoHash);
    if (!torrent) return res.status(404).json({ error: "Torrent not found" });

    const file = torrent.files[parseInt(params.fileIndex, 10)];
    if (!file) return res.status(404).json({ error: "File not found" });

    const filePath = diskPath(torrent, file);
    const streamIdx = parseInt(params.streamIndex, 10);

    // Check file exists on disk
    try { statSync(filePath); } catch {
      return res.status(202).json({ error: "File not on disk yet" });
    }

    const offset = parseFloat(req.query.offset as string) || 0;
    log("info", "Extracting embedded subtitle", { file: file.name, stream: streamIdx, offset });

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
    res.setHeader("Access-Control-Allow-Origin", "*");
    ffmpeg.stdout!.pipe(res);
    ffmpeg.stderr!.on("data", (d: Buffer) => log("warn", "Sub extract: " + d.toString().trim()));
    ffmpeg.on("close", (code: number | null) => {
      if (code !== 0) log("err", "Sub extract failed", { stream: streamIdx, code });
    });
    res.on("close", () => ffmpeg.kill());
  });
}
