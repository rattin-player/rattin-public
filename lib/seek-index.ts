import { spawn } from "child_process";
import { getFileOffset } from "./torrent-compat.js";
import type { SeekEntry, Torrent, TorrentFile } from "./types.js";

// ── Seek Index ─────────────────────────────────────────────────────────
// Builds a keyframe index (time -> byte offset) from ffprobe output.
// Used to map seek times to torrent piece ranges for on-demand fetching.

const BUFFER_SIZE = 10 * 1024 * 1024; // 10MB of data beyond seek point

/**
 * Build a keyframe index for a media file.
 * Returns [{ time: number, offset: number }, ...] sorted by time.
 */
export function buildSeekIndex(filePath: string, timeoutMs: number = 15000): Promise<SeekEntry[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-select_streams", "v:0",
      "-show_entries", "packet=pos,pts_time,flags",
      "-skip_frame", "nokey",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("ffprobe timeout"));
    }, timeoutMs);

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}`));
      try {
        const data = JSON.parse(out);
        const packets: Array<{ pts_time: string; pos: string; flags: string }> = data.packets || [];
        const index: SeekEntry[] = [];
        for (const pkt of packets) {
          const time = parseFloat(pkt.pts_time);
          const offset = parseInt(pkt.pos, 10);
          // Only include keyframes with valid position and time
          if (isFinite(time) && time >= 0 && isFinite(offset) && offset >= 0) {
            index.push({ time, offset });
          }
        }
        index.sort((a, b) => a.time - b.time);
        resolve(index);
      } catch (e) {
        reject(new Error("Failed to parse ffprobe output: " + (e as Error).message));
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Binary search the seek index for the keyframe at or before the target time.
 */
export function findSeekOffset(index: SeekEntry[], timeSeconds: number): SeekEntry | null {
  if (!index || index.length === 0) return null;

  let lo = 0, hi = index.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (index[mid].time <= timeSeconds) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return index[best];
}

/**
 * Wait for torrent pieces covering a byte range to be downloaded.
 * Uses the deselect-then-reselect pattern: removes the whole-file selection
 * so the seek range becomes the sole active selection, forcing WebTorrent
 * to download those pieces first. Restores the file selection on completion.
 *
 * NOTE: torrent.critical() does NOT change download order -- it only enables
 * hotswapping. The only way to prioritize a piece range is to make it the
 * sole active selection via deselect/select.
 */
export function waitForPieces(torrent: Torrent, file: TorrentFile, byteStart: number, byteEnd: number, timeoutMs: number = 30000): Promise<void> {
  const pieceLength = torrent.pieceLength;
  // Convert file-relative byte offsets to absolute torrent byte offsets
  const fileOffset = getFileOffset(file);
  const absStart = fileOffset + byteStart;
  const absEnd = Math.min(fileOffset + byteEnd, fileOffset + file.length - 1);
  const firstPiece = Math.floor(absStart / pieceLength);
  const lastPiece = Math.floor(absEnd / pieceLength);

  function allPresent(): boolean {
    for (let i = firstPiece; i <= lastPiece; i++) {
      if (!torrent.bitfield.get(i)) return false;
    }
    return true;
  }

  if (allPresent()) return Promise.resolve();

  // Deselect the whole file so in-flight sequential requests don't compete,
  // then select ONLY the seek range -- this forces WebTorrent to download
  // these pieces first (proven in poc-seek-test.mjs).
  file.deselect();
  torrent.select(firstPiece, lastPiece, 5);

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      torrent.removeListener("verified", onVerified);
      // Restore file selection even on timeout
      torrent.deselect(firstPiece, lastPiece);
      file.select();
      reject(new Error("Piece download timeout"));
    }, timeoutMs);

    function onVerified(): void {
      if (allPresent()) {
        clearTimeout(timer);
        torrent.removeListener("verified", onVerified);
        // Restore whole-file selection so sequential download resumes
        torrent.deselect(firstPiece, lastPiece);
        file.select();
        resolve();
      }
    }

    torrent.on("verified", onVerified);
  });
}

/**
 * Calculate the byte range needed for a seek operation.
 */
export function getSeekByteRange(seekPoint: SeekEntry, fileLength: number): { byteStart: number; byteEnd: number } {
  const byteStart = seekPoint.offset;
  const byteEnd = Math.min(byteStart + BUFFER_SIZE, fileLength - 1);
  return { byteStart, byteEnd };
}
