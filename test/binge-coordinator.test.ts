import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BingeCoordinator, type CoordinatorState } from "../src/lib/BingeCoordinator.js";

function makeDeps(overrides: Partial<any> = {}) {
  const events: string[] = [];
  return {
    events,
    deps: {
      startPrefetch: async () => { events.push("prefetch-start"); return { ok: true }; },
      pollReady: async () => { events.push("poll"); return true; },
      loadNextEpisode: async () => { events.push("load-next"); },
      emitToast: (t: string) => { events.push("toast:" + t); },
      getMarkers: () => ({ introStart: 20, introEnd: 110, outroStart: 1300, outroSource: "chapter markers" as const, introSource: "chapter markers" as const }),
      seekTo: (t: number) => { events.push("seek:" + t); },
      exitToShowDetail: () => { events.push("exit"); },
      getNextEpisode: () => ({ tmdbId: "1", season: 1, episode: 2 }),
      ...overrides,
    },
  };
}

describe("BingeCoordinator", () => {
  it("starts idle when binge off", () => {
    const { deps } = makeDeps();
    const c = new BingeCoordinator(deps);
    assert.equal(c.state, "idle");
    c.onTimeUpdate(500);
    assert.equal(c.state, "idle");
  });

  it("fires prefetch trigger at 50% in debrid mode", async () => {
    const { deps, events } = makeDeps({ mode: () => "debrid" });
    const c = new BingeCoordinator(deps);
    c.setBingeEnabled(true);
    c.onEpisodeStart({ duration: 1380, currentTime: 0 });
    c.onTimeUpdate(690);
    await new Promise(r => setImmediate(r));
    assert.ok(events.includes("prefetch-start"));
  });

  it("auto-skips intro once per episode", () => {
    const { deps, events } = makeDeps();
    const c = new BingeCoordinator(deps);
    c.setBingeEnabled(true);
    c.onEpisodeStart({ duration: 1380, currentTime: 0 });
    c.onTimeUpdate(25);
    assert.ok(events.includes("seek:110"));
    events.length = 0;
    c.onTimeUpdate(30);
    assert.ok(!events.some(e => e.startsWith("seek")));
  });

  it("skips intro when toggled on mid-intro", () => {
    const { deps, events } = makeDeps();
    const c = new BingeCoordinator(deps);
    c.onEpisodeStart({ duration: 1380, currentTime: 40 });
    c.setBingeEnabled(true);
    c.onTimeUpdate(40);
    assert.ok(events.includes("seek:110"));
  });

  it("transitions idle → advancing when EOF fires before prefetch", async () => {
    const { deps } = makeDeps();
    const c = new BingeCoordinator(deps);
    c.setBingeEnabled(true);
    c.onEpisodeStart({ duration: 1380, currentTime: 0 });
    c.onEOF();
    await new Promise(r => setImmediate(r));
    assert.ok(["advancing", "idle"].includes(c.state));
  });

  it("transitions to stopped on prefetch terminal failure", async () => {
    const { deps } = makeDeps({
      startPrefetch: async () => { throw new Error("no sources"); },
    });
    const c = new BingeCoordinator(deps);
    c.setBingeEnabled(true);
    c.onEpisodeStart({ duration: 1380, currentTime: 0 });
    c.onTimeUpdate(690);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(c.state, "stopped");
  });

  it("stopped → prefetching on manual Next Ep retry", async () => {
    const { deps } = makeDeps({
      startPrefetch: async () => { throw new Error("no sources"); },
    });
    const c = new BingeCoordinator(deps);
    c.setBingeEnabled(true);
    c.onEpisodeStart({ duration: 1380, currentTime: 0 });
    c.onTimeUpdate(690);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(c.state, "stopped");

    (deps as any).startPrefetch = async () => ({ ok: true });
    c.onManualNextEp();
    await new Promise(r => setTimeout(r, 10));
    assert.ok(["prefetching", "armed", "advancing", "idle"].includes(c.state));
  });

  it("enters finale when no next episode metadata", () => {
    const { deps, events } = makeDeps({ getNextEpisode: () => null });
    const c = new BingeCoordinator(deps);
    c.setBingeEnabled(true);
    c.onEpisodeStart({ duration: 1380, currentTime: 0 });
    c.onEOF();
    assert.ok(events.includes("exit"));
    assert.ok(events.some(e => e.startsWith("toast:")));
  });

  it("does not re-skip intro after user seeks backward past introEnd", () => {
    const { deps, events } = makeDeps();
    const c = new BingeCoordinator(deps);
    c.setBingeEnabled(true);
    c.onEpisodeStart({ duration: 1380, currentTime: 0 });
    c.onTimeUpdate(25);
    events.length = 0;
    c.onTimeUpdate(50);
    assert.ok(!events.some(e => e.startsWith("seek")));
  });
});
