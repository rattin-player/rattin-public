// Audio fingerprint extraction (via fpcalc) and cross-correlation for intro detection.
import { execFile } from "child_process";

// Count set bits in a 32-bit integer
export function popcount32(n) {
  n = n - ((n >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  return (((n + (n >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
}

// Similarity score between two fingerprint values (0.0 = no match, 1.0 = identical)
export function matchScore(a, b) {
  const diff = popcount32((a ^ b) >>> 0);
  return 1.0 - diff / 32;
}

const MIN_INTRO_SECS = 30;
const MAX_INTRO_SECS = 180;
const MAX_INTRO_START = 600; // 10 minutes
// Real-world chromaprint similarity for identical audio from different encodes
// is ~0.5-0.6 (not 0.9+), due to codec/bitrate variations.
const MATCH_THRESHOLD = 0.42;
const MIN_SCORE = 0.45;

export { MIN_INTRO_SECS, MAX_INTRO_SECS, MAX_INTRO_START };

/**
 * Find the longest matching audio segment between two fingerprint arrays.
 * @param {number[]} fpA - fingerprint array for episode A
 * @param {number[]} fpB - fingerprint array for episode B
 * @param {number} [rate=1] - fingerprint samples per second (from fpcalc: fp.length / duration)
 * Returns { offsetA, offsetB, duration, score } in SECONDS, or null.
 */
export function crossCorrelate(fpA, fpB, rate = 1) {
  let best = null;

  // Convert second-based thresholds to sample counts
  const minSamples = Math.round(MIN_INTRO_SECS * rate);
  const maxSamples = Math.round(MAX_INTRO_SECS * rate);
  const maxStartSamples = Math.round(MAX_INTRO_START * rate);

  const minOffset = -(fpB.length - 1);
  const maxOffset = fpA.length - 1;

  for (let offset = minOffset; offset <= maxOffset; offset++) {
    const startA = Math.max(0, offset);
    const startB = Math.max(0, -offset);
    const len = Math.min(fpA.length - startA, fpB.length - startB);

    let runStart = -1;
    let runScoreSum = 0;
    let runLen = 0;

    for (let k = 0; k <= len; k++) {
      const sim = k < len ? matchScore(fpA[startA + k], fpB[startB + k]) : 0;
      if (sim >= MATCH_THRESHOLD) {
        if (runStart === -1) runStart = k;
        runScoreSum += sim;
        runLen++;
      } else {
        if (runLen >= minSamples) {
          const avgScore = runScoreSum / runLen;
          if (avgScore >= MIN_SCORE && (!best || runLen > best._runLen || (runLen === best._runLen && avgScore > best.score))) {
            const oA = startA + runStart;
            const oB = startB + runStart;
            if (oA <= maxStartSamples && oB <= maxStartSamples && runLen <= maxSamples) {
              best = {
                offsetA: Math.round(oA / rate),
                offsetB: Math.round(oB / rate),
                duration: Math.round(runLen / rate),
                score: avgScore,
                _runLen: runLen, // internal: for comparing runs in samples
              };
            }
          }
        }
        runStart = -1;
        runScoreSum = 0;
        runLen = 0;
      }
    }
  }

  if (best) delete best._runLen;
  return best;
}

const FPCALC_TIMEOUT = 60_000; // 60 seconds

/**
 * Extract audio fingerprint from a media file using fpcalc (chromaprint).
 * Uses ffmpeg to extract only the first N seconds of audio (fpcalc's -length is unreliable).
 * Returns { fingerprint: number[], duration: number } where duration is in seconds.
 * @param {string} filePath - path to media file
 * @param {number} [durationSec=300] - how many seconds to analyze
 */
export function extractFingerprint(filePath, durationSec = 300) {
  return new Promise((resolve, reject) => {
    // Use ffmpeg to extract limited audio, pipe to fpcalc via temp wav
    // fpcalc's -length flag doesn't reliably limit analysis on some formats
    const tmpWav = `/tmp/fp_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`;
    const ffmpeg = execFile(
      "ffmpeg",
      ["-i", filePath, "-t", String(durationSec), "-ac", "1", "-ar", "16000", "-f", "wav", tmpWav, "-y", "-loglevel", "error"],
      { timeout: FPCALC_TIMEOUT },
      (ffErr) => {
        if (ffErr) return reject(ffErr);
        execFile(
          "fpcalc",
          ["-raw", "-json", tmpWav],
          { timeout: FPCALC_TIMEOUT },
          (err, stdout) => {
            // Clean up temp file
            import("fs").then(fs => fs.unlink(tmpWav, () => {}));
            if (err) return reject(err);
            try {
              const data = JSON.parse(stdout);
              if (!data.fingerprint || !Array.isArray(data.fingerprint)) {
                return reject(new Error("fpcalc returned no fingerprint array"));
              }
              resolve({ fingerprint: data.fingerprint, duration: data.duration || durationSec });
            } catch (e) {
              reject(new Error("Failed to parse fpcalc output: " + e.message));
            }
          }
        );
      }
    );
  });
}
