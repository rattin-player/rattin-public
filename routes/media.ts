import path from "path";
import fs from "fs";
import { createReadStream, statSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import type { Express, Request, Response } from "express";
import { jobKey } from "../lib/cache/torrent-caches.js";
import { getFileOffset } from "../lib/torrent/torrent-compat.js";
import { hasPiece } from "../lib/torrent/torrent-compat.js";
import { VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS, srtToVtt } from "../lib/media/media-utils.js";
import { detectIntro, lookupExternal, lookupAniskipMarkers } from "../lib/media/intro-detect.js";
import { lookupIntrodbMarkers } from "../lib/media/introdb.js";
import { isAnime } from "../lib/media/anime-detect.js";
import type { ServerContext, Torrent } from "../lib/types.js";
import { getActiveDebridUrl, getActiveDebridFiles, getDebridFileUrl } from "../lib/torrent/debrid.js";

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

    // Debrid takes priority
    const debridUrl = getActiveDebridUrl(infoHash, parseInt(fileIndex, 10));
    if (debridUrl) {
      filePath = debridUrl;
    } else if (torrent) {
      const file = torrent.files[parseInt(fileIndex, 10)];
      if (!file) return res.status(404).json({ error: "File not found" });
      filePath = diskPath(torrent, file);
      try { statSync(filePath); } catch {
        return res.json({ duration: null });
      }
    } else {
      return res.status(404).json({ error: "Torrent not found" });
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
  // CHECKS DEBRID FIRST: if a debrid stream is active, serves subtitle from debrid provider.
  // Falls back to webtorrent only if no debrid stream is registered.
  app.get("/api/subtitle/:infoHash/:fileIndex", async (req: Request, res: Response) => {
    const { infoHash, fileIndex } = req.params as Record<string, string>;

    // Debrid takes priority — if an active debrid stream exists, fetch from debrid
    const debridFiles = getActiveDebridFiles(infoHash);
    if (debridFiles.length > 0) {
      const fileIdx = parseInt(fileIndex, 10);
      // fileIndex is 0-based positional — map directly to debridFiles array
      const debridFile = fileIdx >= 0 && fileIdx < debridFiles.length ? debridFiles[fileIdx] : undefined;
      if (!debridFile) return res.status(404).json({ error: "File not found" });
      const ext = path.extname(debridFile.path).toLowerCase();
      if (!SUBTITLE_EXTENSIONS.includes(ext)) {
        return res.status(400).json({ error: "Not a subtitle file" });
      }
      const offset = parseFloat(req.query.offset as string) || 0;

      try {
        // Get unrestricted download URL for this specific file
        const fileUrl = await getDebridFileUrl(infoHash, debridFile.id);
        if (!fileUrl) {
          log("err", "/api/subtitle — could not get debrid file URL", { infoHash, fileId: debridFile.id });
          return res.status(502).json({ error: "Could not get debrid download link" });
        }

        // Fetch subtitle content from debrid provider
        const subRes = await fetch(fileUrl);
        if (!subRes.ok) {
          log("err", "/api/subtitle — debrid fetch failed", { status: subRes.status, infoHash, fileId: debridFile.id });
          return res.status(502).json({ error: "Failed to fetch subtitle from debrid" });
        }
        const subBuffer = Buffer.from(await subRes.arrayBuffer());
        const raw = subBuffer.toString("utf-8");
        res.setHeader("Content-Type", "text/vtt; charset=utf-8");

        if (ext === ".vtt") {
          return res.send(offset > 0 ? "" : raw); // TODO: shift VTT if offset > 0
        }
        if (ext === ".srt") {
          return res.send(srtToVtt(raw));
        }
        // Other formats: pipe through ffmpeg
        const args = [
          ...(offset > 0 ? ["-ss", String(offset)] : []),
          "-i", "pipe:0", "-f", "webvtt", "-v", "warning", "pipe:1",
        ];
        const ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
        ffmpeg.stdin!.end(subBuffer);
        ffmpeg.stdout!.pipe(res);
        ffmpeg.stderr!.on("data", (d: Buffer) => log("warn", "Subtitle ffmpeg: " + d.toString().trim()));
        ffmpeg.on("close", (code: number | null) => {
          if (code !== 0) log("err", "Subtitle conversion from debrid failed", { code });
        });
        res.on("close", () => ffmpeg.kill());
        return;
      } catch (err) {
        log("err", "/api/subtitle — debrid serving error", { error: (err as Error).message });
        return res.status(500).json({ error: "Failed to serve subtitle from debrid" });
      }
    }

    // Fall back to webtorrent
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
  // CHECKS DEBRID FIRST: if a debrid stream is active, always probe the debrid URL.
  // Falls back to webtorrent only if no debrid stream is registered.
  app.get("/api/subtitles/:infoHash/:fileIndex", (req: Request, res: Response) => {
    res.removeHeader("ETag");
    res.setHeader("Cache-Control", "no-store");
    const { infoHash, fileIndex } = req.params as Record<string, string>;

    let filePath: string;
    let complete: boolean;

    // Debrid takes priority — if an active debrid stream exists, use its URL
    const debridUrl = getActiveDebridUrl(infoHash, parseInt(fileIndex, 10));
    if (debridUrl) {
      filePath = debridUrl;
      complete = true;
    } else {
      const torrent = client().torrents.find((t) => t.infoHash === infoHash);
      if (torrent) {
        const file = torrent.files[parseInt(fileIndex, 10)];
        if (!file) return res.status(404).json({ error: "File not found" });
        complete = isFileComplete(torrent, file);
        filePath = diskPath(torrent, file);
        try { statSync(filePath); } catch {
          return res.json({ tracks: [], complete: false });
        }
      } else {
        return res.status(404).json({ error: "Torrent not found" });
      }
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

    let filePath: string;
    let complete: boolean;

    // Debrid takes priority
    const debridUrl = getActiveDebridUrl(infoHash, parseInt(fileIndex, 10));
    if (debridUrl) {
      filePath = debridUrl;
      complete = true;
    } else {
      const torrent = client().torrents.find((t) => t.infoHash === infoHash);
      if (torrent) {
        const file = torrent.files[parseInt(fileIndex, 10)];
        if (!file) return res.status(404).json({ error: "File not found" });
        complete = isFileComplete(torrent, file);
        filePath = diskPath(torrent, file);
        try { statSync(filePath); } catch {
          return res.json({ tracks: [], complete: false });
        }
      } else {
        return res.status(404).json({ error: "Torrent not found" });
      }
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

  // Binge mode: is the next-episode source ready enough to start playback?
  //   debrid: an active stream URL exists for (infoHash, fileIndex)
  //   native: torrent is in client and the file's first piece is downloaded
  app.get("/api/prefetch-ready", (req: Request, res: Response) => {
    const { infoHash, fileIndex } = req.query as { infoHash?: string; fileIndex?: string };
    if (!infoHash || fileIndex === undefined) {
      return res.status(400).json({ error: "infoHash and fileIndex required" });
    }
    const fi = Number(fileIndex);
    if (!Number.isFinite(fi)) return res.status(400).json({ error: "fileIndex must be a number" });

    const debridUrl = getActiveDebridUrl(infoHash, fi);
    if (debridUrl) return res.json({ ready: true });

    const torrent = client().torrents.find((t) => t.infoHash === infoHash || t.infoHash === infoHash.toLowerCase());
    if (!torrent) return res.json({ ready: false });
    const file = torrent.files?.[fi];
    if (!file) return res.json({ ready: false });
    try {
      const byteOffset = getFileOffset(file);
      const pieceLen = (torrent as unknown as { pieceLength?: number }).pieceLength;
      if (!pieceLen || !Number.isFinite(pieceLen)) return res.json({ ready: false });
      const startPiece = Math.floor(byteOffset / pieceLen);
      return res.json({ ready: hasPiece(torrent, startPiece) });
    } catch {
      return res.json({ ready: false });
    }
  });

  // Binge mode: fetch OP/ED markers from AniSkip (anime only, via anime-gate) and/or
  // IntroDB (IMDb-keyed). Returns null for each source when data is unavailable.
  app.get("/api/episode-markers", async (req: Request, res: Response) => {
    const { title, episode, duration, season, tmdbId, imdbId } = req.query as {
      title?: string; episode?: string; duration?: string; season?: string;
      tmdbId?: string; imdbId?: string;
    };
    if (!title || !episode || !duration) {
      return res.status(400).json({ error: "title, episode, duration required" });
    }
    const ep = Number(episode);
    const dur = Number(duration);
    const seasonNum = season != null && season !== "" ? Number(season) : 1;
    if (!Number.isFinite(ep) || !Number.isFinite(dur) || !Number.isFinite(seasonNum)) {
      return res.status(400).json({ error: "episode, duration, and season must be numbers" });
    }

    const [anime, introdb] = await Promise.all([
      tmdbId ? isAnime(tmdbId).catch(() => false) : Promise.resolve(false),
      imdbId ? lookupIntrodbMarkers(imdbId, seasonNum, ep).catch(() => null) : Promise.resolve(null),
    ]);

    let aniskip = null;
    if (anime) {
      try {
        aniskip = await lookupAniskipMarkers(title, ep, dur, seasonNum);
        if (aniskip) {
          log("info", "AniSkip lookup", {
            title, season: seasonNum, episode: ep,
            malId: aniskip.resolution.malId,
            jikanTitle: aniskip.resolution.jikanTitle,
            op: `${aniskip.opStart}-${aniskip.opEnd}`,
            ed: aniskip.edStart,
          });
        } else {
          log("info", "AniSkip lookup: no markers", { title, season: seasonNum, episode: ep });
        }
      } catch (err) {
        log("warn", "AniSkip markers lookup failed", { error: (err as Error).message });
      }
    }

    if (introdb) {
      log("info", "IntroDB lookup", {
        imdbId: introdb.imdbId, season: seasonNum, episode: ep,
        intro: introdb.intro ? `${introdb.intro.startSec}-${introdb.intro.endSec} (n=${introdb.intro.submissionCount})` : null,
        outro: introdb.outro ? `${introdb.outro.startSec} (n=${introdb.outro.submissionCount})` : null,
      });
    }

    res.json({ aniskip, introdb });
  });

  // Extract an embedded subtitle stream as WebVTT
  app.get("/api/subtitle-extract/:infoHash/:fileIndex/:streamIndex", (req: Request, res: Response) => {
    const params = req.params as Record<string, string>;
    let filePath: string;

    // Debrid takes priority
    const debridUrl = getActiveDebridUrl(params.infoHash, parseInt(params.fileIndex, 10));
    if (debridUrl) {
      filePath = debridUrl;
    } else {
      const torrent = client().torrents.find((t) => t.infoHash === params.infoHash);
      if (torrent) {
        const file = torrent.files[parseInt(params.fileIndex, 10)];
        if (!file) return res.status(404).json({ error: "File not found" });
        filePath = diskPath(torrent, file);
        try { statSync(filePath); } catch {
          return res.status(202).json({ error: "File not on disk yet" });
        }
      } else {
        return res.status(404).json({ error: "Torrent not found" });
      }
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

  // Upload a custom subtitle file
  app.post("/api/subtitle/upload", (req: Request, res: Response) => {
    const originalName = (req.query.filename as string) || "subtitle.srt";
    const ext = path.extname(originalName).toLowerCase();

    if (!SUBTITLE_EXTENSIONS.includes(ext)) {
      return res.status(400).json({ error: "Unsupported subtitle format" });
    }

    const subsDir = path.join(DOWNLOAD_PATH, ".custom-subs");
    try {
      mkdirSync(subsDir, { recursive: true });
    } catch (err) {
      log("err", "Failed to create custom-subs dir", { error: (err as Error).message });
      return res.status(500).json({ error: "Could not create upload directory" });
    }

    const sanitized = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeName = `${Date.now()}-${sanitized}`;
    const destPath = path.join(subsDir, safeName);

    const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
    let received = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_SIZE) {
        req.destroy();
        if (!res.headersSent) {
          res.status(413).json({ error: "File too large (max 10 MB)" });
        }
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (res.headersSent) return;
      try {
        fs.writeFileSync(destPath, Buffer.concat(chunks));
        log("info", "Custom subtitle uploaded", { safeName, size: received });
        res.json({ url: `/api/subtitle/custom/${safeName}` });
      } catch (err) {
        log("err", "Failed to write subtitle file", { error: (err as Error).message });
        res.status(500).json({ error: "Failed to save subtitle file" });
      }
    });

    req.on("error", (err: Error) => {
      log("err", "Subtitle upload stream error", { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: "Upload failed" });
      }
    });
  });

  // Serve an uploaded custom subtitle file, converting to VTT
  app.get("/api/subtitle/custom/:filename", (req: Request, res: Response) => {
    const { filename } = req.params as Record<string, string>;

    // Prevent directory traversal
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    const ext = path.extname(filename).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.includes(ext)) {
      return res.status(400).json({ error: "Unsupported subtitle format" });
    }

    const filePath = path.join(DOWNLOAD_PATH, ".custom-subs", filename);

    try {
      statSync(filePath);
    } catch {
      return res.status(404).json({ error: "Subtitle file not found" });
    }

    res.setHeader("Content-Type", "text/vtt; charset=utf-8");

    if (ext === ".vtt") {
      return createReadStream(filePath).pipe(res);
    }

    if (ext === ".srt") {
      try {
        const srtContent = fs.readFileSync(filePath, "utf-8");
        return res.send(srtToVtt(srtContent));
      } catch (err) {
        log("err", "SRT read failed for custom subtitle", { error: (err as Error).message });
        return res.status(500).json({ error: "Failed to read subtitle file" });
      }
    }

    // .ass, .ssa, .sub — convert via ffmpeg
    log("info", "Converting custom subtitle via ffmpeg", { filename, ext });
    const ffmpeg = spawn("ffmpeg", [
      "-i", filePath,
      "-f", "webvtt",
      "-v", "warning",
      "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    ffmpeg.stdout!.pipe(res);
    ffmpeg.stderr!.on("data", (d: Buffer) => log("warn", "Custom sub ffmpeg: " + d.toString().trim()));
    ffmpeg.on("close", (code: number | null) => {
      if (code !== 0) log("err", "Custom subtitle conversion failed", { filename, code });
    });
    res.on("close", () => ffmpeg.kill());
  });

}
