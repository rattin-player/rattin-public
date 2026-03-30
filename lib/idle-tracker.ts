// lib/idle-tracker.ts
// App-level idle detection: tracks last user activity and triggers
// escalating cleanup when the app sits unused.
//
// Cleanup tiers (all configurable):
//   IDLE_SOFT  (5 min) — purge expired TMDB entries, destroy unstreamed torrents
//   IDLE_HARD (10 min) — destroy ALL torrents, clear all caches

import type { Request, Response, NextFunction } from "express";
import type { IdleTrackerOpts, IdleTracker } from "./types.js";

export const IDLE_SOFT: number = 5 * 60 * 1000;   // 5 minutes
export const IDLE_HARD: number = 10 * 60 * 1000;  // 10 minutes
const CHECK_INTERVAL = 60 * 1000;         // check every 1 minute

export function createIdleTracker({ onSoftIdle, onHardIdle, logFn }: IdleTrackerOpts = {}): IdleTracker {
  let lastActivity = Date.now();
  let softFired = false;
  let hardFired = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function touch(): void {
    lastActivity = Date.now();
    // Reset idle flags when user returns
    if (softFired || hardFired) {
      if (logFn) logFn("info", "Activity resumed, clearing idle state");
    }
    softFired = false;
    hardFired = false;
  }

  function idleDuration(): number {
    return Date.now() - lastActivity;
  }

  function check(): void {
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

  function start(): void {
    if (timer) return;
    timer = setInterval(check, CHECK_INTERVAL);
    // Don't prevent process exit
    if (timer.unref) timer.unref();
  }

  function stop(): void {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // Express middleware — call touch() on every API request
  function middleware(_req: Request, _res: Response, next: NextFunction): void {
    touch();
    next();
  }

  return { touch, idleDuration, check, start, stop, middleware };
}
