import { spawn } from "child_process";

// ── Seek Index ─────────────────────────────────────────────────────────
// Builds a keyframe index (time → byte offset) from ffprobe output.
// Used to map seek times to torrent piece ranges for on-demand fetching.

const BUFFER_SIZE = 10 * 1024 * 1024; // 10MB of data beyond seek point

/**
 * Build a keyframe index for a media file.
 * Returns [{ time: number, offset: number }, ...] sorted by time.
 * @param {string} filePath - Path to the file on disk
 * @param {number} [timeoutMs=15000] - Max time to wait for ffprobe
 */
export function buildSeekIndex(filePath, timeoutMs = 15000) {
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
    proc.stdout.on("data", (d) => { out += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("ffprobe timeout"));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}`));
      try {
        const data = JSON.parse(out);
        const packets = data.packets || [];
        const index = [];
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
        reject(new Error("Failed to parse ffprobe output: " + e.message));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Binary search the seek index for the keyframe at or before the target time.
 * @param {{ time: number, offset: number }[]} index
 * @param {number} timeSeconds
 * @returns {{ time: number, offset: number } | null}
 */
export function findSeekOffset(index, timeSeconds) {
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
 * Prioritizes the pieces via torrent.critical() and waits for verification.
 * @param {object} torrent - WebTorrent torrent instance
 * @param {object} file - WebTorrent file instance
 * @param {number} byteStart - Start byte offset within the file
 * @param {number} byteEnd - End byte offset within the file
 * @param {number} [timeoutMs=30000] - Max time to wait
 * @returns {Promise<void>} Resolves when all pieces are available
 */
export function waitForPieces(torrent, file, byteStart, byteEnd, timeoutMs = 30000) {
  const pieceLength = torrent.pieceLength;
  // Convert file-relative byte offsets to absolute torrent byte offsets
  const absStart = file.offset + byteStart;
  const absEnd = Math.min(file.offset + byteEnd, file.offset + file.length - 1);
  const firstPiece = Math.floor(absStart / pieceLength);
  const lastPiece = Math.floor(absEnd / pieceLength);

  function allPresent() {
    for (let i = firstPiece; i <= lastPiece; i++) {
      if (!torrent.bitfield.get(i)) return false;
    }
    return true;
  }

  if (allPresent()) return Promise.resolve();

  // Mark pieces as critical priority
  torrent.critical(firstPiece, lastPiece);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      torrent.removeListener("verified", onVerified);
      reject(new Error("Piece download timeout"));
    }, timeoutMs);

    function onVerified() {
      if (allPresent()) {
        clearTimeout(timer);
        torrent.removeListener("verified", onVerified);
        resolve();
      }
    }

    torrent.on("verified", onVerified);
  });
}

/**
 * Calculate the byte range needed for a seek operation.
 * @param {{ time: number, offset: number }} seekPoint - From findSeekOffset
 * @param {number} fileLength - Total file length in bytes
 * @returns {{ byteStart: number, byteEnd: number }}
 */
export function getSeekByteRange(seekPoint, fileLength) {
  const byteStart = seekPoint.offset;
  const byteEnd = Math.min(byteStart + BUFFER_SIZE, fileLength - 1);
  return { byteStart, byteEnd };
}
