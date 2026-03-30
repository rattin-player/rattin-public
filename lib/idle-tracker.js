// lib/idle-tracker.js
// App-level idle detection: tracks last user activity and triggers
// escalating cleanup when the app sits unused.
//
// Cleanup tiers (all configurable):
//   IDLE_SOFT  (5 min) — purge expired TMDB entries, destroy unstreamed torrents
//   IDLE_HARD (10 min) — destroy ALL torrents, clear all caches

export const IDLE_SOFT = 5 * 60 * 1000;   // 5 minutes
export const IDLE_HARD = 10 * 60 * 1000;  // 10 minutes
const CHECK_INTERVAL = 60 * 1000;         // check every 1 minute

export function createIdleTracker({ onSoftIdle, onHardIdle, logFn } = {}) {
  let lastActivity = Date.now();
  let softFired = false;
  let hardFired = false;
  let timer = null;

  function touch() {
    lastActivity = Date.now();
    // Reset idle flags when user returns
    if (softFired || hardFired) {
      if (logFn) logFn("info", "Activity resumed, clearing idle state");
    }
    softFired = false;
    hardFired = false;
  }

  function idleDuration() {
    return Date.now() - lastActivity;
  }

  function check() {
    const idle = idleDuration();
    if (!hardFired && idle >= IDLE_HARD) {
      hardFired = true;
      softFired = true;
      if (logFn) logFn("info", "Hard idle threshold reached", { idleMin: (idle / 60000).toFixed(1) });
      if (onHardIdle) onHardIdle();
    } else if (!softFired && idle >= IDLE_SOFT) {
      softFired = true;
      if (logFn) logFn("info", "Soft idle threshold reached", { idleMin: (idle / 60000).toFixed(1) });
      if (onSoftIdle) onSoftIdle();
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(check, CHECK_INTERVAL);
    // Don't prevent process exit
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // Express middleware — call touch() on every API request
  function middleware(req, res, next) {
    touch();
    next();
  }

  return { touch, idleDuration, check, start, stop, middleware };
}
