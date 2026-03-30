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
const MATCH_THRESHOLD = 0.65; // minimum per-second similarity to count as matching
const MIN_SCORE = 0.55; // minimum average score for the matched region

export { MIN_INTRO_SECS, MAX_INTRO_SECS, MAX_INTRO_START };

/**
 * Find the longest matching audio segment between two fingerprint arrays.
 * Each array entry represents ~1 second of audio.
 * Returns { offsetA, offsetB, duration, score } or null.
 */
export function crossCorrelate(fpA, fpB) {
  let best = null;

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
        if (runLen >= MIN_INTRO_SECS) {
          const avgScore = runScoreSum / runLen;
          if (avgScore >= MIN_SCORE && (!best || runLen > best.duration || (runLen === best.duration && avgScore > best.score))) {
            const oA = startA + runStart;
            const oB = startB + runStart;
            if (oA <= MAX_INTRO_START && oB <= MAX_INTRO_START && runLen <= MAX_INTRO_SECS) {
              best = { offsetA: oA, offsetB: oB, duration: runLen, score: avgScore };
            }
          }
        }
        runStart = -1;
        runScoreSum = 0;
        runLen = 0;
      }
    }
  }

  return best;
}

const FPCALC_TIMEOUT = 30_000; // 30 seconds

export function extractFingerprint(filePath, durationSec = 300) {
  return new Promise((resolve, reject) => {
    execFile(
      "fpcalc",
      ["-raw", "-length", String(durationSec), "-json", filePath],
      { timeout: FPCALC_TIMEOUT },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const data = JSON.parse(stdout);
          if (!data.fingerprint || !Array.isArray(data.fingerprint)) {
            return reject(new Error("fpcalc returned no fingerprint array"));
          }
          resolve(data.fingerprint);
        } catch (e) {
          reject(new Error("Failed to parse fpcalc output: " + e.message));
        }
      }
    );
  });
}
