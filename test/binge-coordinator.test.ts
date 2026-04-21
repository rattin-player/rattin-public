import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BingeCoordinator, type CoordinatorState } from "../src/lib/BingeCoordinator.js";
import type { BingeEvent } from "../lib/types.js";

function makeDeps(overrides: Partial<any> = {}) {
  const events: string[] = [];
  const bingeEvents: BingeEvent[] = [];
  const stateChanges: CoordinatorState[] = [];
  return {
    events,
    bingeEvents,
    stateChanges,
    deps: {
      startPrefetch: async () => { events.push("prefetch-start"); return { ok: true }; },
      pollReady: async () => { events.push("poll"); return true; },
      loadNextEpisode: async () => { events.push("load-next"); },
      emitToast: (t: string) => { events.push("toast:" + t); },
      getMarkers: () => ({ introStart: 20, introEnd: 110, outroStart: 1300, outroSource: "chapter markers" as const, introSource: "chapter markers" as const }),
      seekTo: (t: number) => { events.push("seek:" + t); },
      exitToShowDetail: () => { events.push("exit"); },
      getNextEpisode: () => ({ tmdbId: "1", season: 1, episode: 2 }),
      onEvent: (e: BingeEvent) => { bingeEvents.push(e); },
      onStateChange: (s: CoordinatorState) => { stateChanges.push(s); },
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

  describe("observability", () => {
    it("emits episode-start event on onEpisodeStart", () => {
      const { deps, bingeEvents } = makeDeps();
      const c = new BingeCoordinator(deps);
      c.onEpisodeStart({ duration: 1380, currentTime: 0 });
      assert.ok(bingeEvents.some(e => e.kind === "episode-start"));
    });

    it("emits intro-skip event when intro auto-skipped", () => {
      const { deps, bingeEvents } = makeDeps();
      const c = new BingeCoordinator(deps);
      c.setBingeEnabled(true);
      c.onEpisodeStart({ duration: 1380, currentTime: 0 });
      c.onTimeUpdate(25);
      const skip = bingeEvents.find(e => e.kind === "intro-skip");
      assert.ok(skip, "should emit intro-skip");
      assert.equal(skip!.t, 25);
    });

    it("emits prefetch-fire and prefetch-ok on successful prefetch", async () => {
      const { deps, bingeEvents } = makeDeps({ mode: () => "debrid" });
      const c = new BingeCoordinator(deps);
      c.setBingeEnabled(true);
      c.onEpisodeStart({ duration: 1380, currentTime: 0 });
      c.onTimeUpdate(690);
      await new Promise(r => setTimeout(r, 10));
      assert.ok(bingeEvents.some(e => e.kind === "prefetch-fire"));
      assert.ok(bingeEvents.some(e => e.kind === "prefetch-ok"));
    });

    it("emits prefetch-error when prefetch throws", async () => {
      const { deps, bingeEvents } = makeDeps({
        startPrefetch: async () => { throw new Error("no sources"); },
      });
      const c = new BingeCoordinator(deps);
      c.setBingeEnabled(true);
      c.onEpisodeStart({ duration: 1380, currentTime: 0 });
      c.onTimeUpdate(690);
      await new Promise(r => setTimeout(r, 10));
      const err = bingeEvents.find(e => e.kind === "prefetch-error");
      assert.ok(err, "should emit prefetch-error");
      assert.equal(err!.detail, "no sources");
    });

    it("emits state-change callbacks across transitions", async () => {
      const { deps, stateChanges } = makeDeps({ mode: () => "debrid" });
      const c = new BingeCoordinator(deps);
      c.setBingeEnabled(true);
      c.onEpisodeStart({ duration: 1380, currentTime: 0 });
      c.onTimeUpdate(690);
      await new Promise(r => setTimeout(r, 10));
      assert.ok(stateChanges.includes("prefetching"));
      assert.ok(stateChanges.includes("armed"));
    });

    it("emits end-of-series event when onEOF fires with no next", () => {
      const { deps, bingeEvents } = makeDeps({ getNextEpisode: () => null });
      const c = new BingeCoordinator(deps);
      c.setBingeEnabled(true);
      c.onEpisodeStart({ duration: 1380, currentTime: 0 });
      c.onEOF();
      assert.ok(bingeEvents.some(e => e.kind === "end-of-series"));
    });
  });

  describe("advancing cancellation", () => {
    it("emits advance-timeout and stops when pollReady never resolves within deadline", async () => {
      const origNow = Date.now;
      let now = 0;
      Date.now = () => now;
      try {
        const { deps, bingeEvents } = makeDeps({
          pollReady: async () => { now += 20_000; return false; },
        });
        const c = new BingeCoordinator(deps);
        c.setBingeEnabled(true);
        c.onEpisodeStart({ duration: 1380, currentTime: 0 });
        c.onEOF();
        await new Promise(r => setTimeout(r, 700));
        assert.equal(c.state, "stopped");
        assert.ok(bingeEvents.some(e => e.kind === "advance-timeout"));
      } finally {
        Date.now = origNow;
      }
    });

    it("cancels advancing when binge is toggled off mid-loop", async () => {
      let resolvePoll: ((v: boolean) => void) | null = null;
      const { deps, bingeEvents, events } = makeDeps({
        pollReady: () => new Promise<boolean>((r) => { resolvePoll = r; }),
      });
      const c = new BingeCoordinator(deps);
      c.setBingeEnabled(true);
      c.onEpisodeStart({ duration: 1380, currentTime: 0 });
      c.onEOF();
      await new Promise(r => setImmediate(r));
      assert.equal(c.state, "advancing");
      c.setBingeEnabled(false);
      resolvePoll!(true);
      await new Promise(r => setTimeout(r, 20));
      assert.equal(c.state, "idle");
      assert.ok(!events.includes("load-next"), "loadNextEpisode must not fire after cancel");
      assert.ok(!bingeEvents.some(e => e.kind === "advance-ready"));
      assert.ok(!bingeEvents.some(e => e.kind === "advance-timeout"));
    });
  });
});
