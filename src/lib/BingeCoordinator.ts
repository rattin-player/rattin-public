import type { MarkerSource } from "../../lib/types.js";

export type CoordinatorState = "idle" | "prefetching" | "armed" | "advancing" | "stopped" | "finale";

interface Markers {
  introStart: number | null;
  introEnd: number | null;
  outroStart: number | null;
  introSource: MarkerSource;
  outroSource: MarkerSource;
}

export interface CoordinatorDeps {
  startPrefetch: () => Promise<unknown>;
  pollReady: () => Promise<boolean>;
  loadNextEpisode: () => Promise<void>;
  emitToast: (msg: string) => void;
  getMarkers: () => Markers;
  seekTo: (seconds: number) => void;
  exitToShowDetail: () => void;
  getNextEpisode: () => { tmdbId: string; season: number; episode: number } | null;
  mode?: () => "debrid" | "native";
}

export class BingeCoordinator {
  state: CoordinatorState = "idle";
  private enabled = false;
  private introAutoSkipped = false;
  private prefetchFired = false;
  private duration = 0;
  private lastTime = 0;

  constructor(private deps: CoordinatorDeps) {}

  setBingeEnabled(on: boolean) {
    const wasOn = this.enabled;
    this.enabled = on;
    if (on && !wasOn) {
      this.maybeSkipIntroAt(this.lastTime);
    }
    if (!on && (this.state === "prefetching" || this.state === "armed" || this.state === "advancing")) {
      this.state = "idle";
    }
  }

  onEpisodeStart(ctx: { duration: number; currentTime: number }) {
    this.duration = ctx.duration;
    this.introAutoSkipped = false;
    this.prefetchFired = false;
    this.state = "idle";
    this.lastTime = ctx.currentTime;
  }

  onTimeUpdate(currentTime: number) {
    this.lastTime = currentTime;
    if (!this.enabled) return;
    this.maybeSkipIntroAt(currentTime);
    this.maybeFirePrefetch(currentTime);
    this.maybeAdvanceOnCredits(currentTime);
  }

  onEOF() {
    if (!this.enabled) return;
    if (this.state === "advancing") return;
    const next = this.deps.getNextEpisode();
    if (!next) {
      this.state = "finale";
      this.deps.emitToast("End of series");
      this.deps.exitToShowDetail();
      return;
    }
    this.enterAdvancing();
  }

  onManualNextEp() {
    if (this.state === "stopped" && this.enabled) {
      void this.enterPrefetching();
    }
  }

  onStop()  { this.state = "stopped"; }
  onBack()  { this.state = "stopped"; }

  private maybeSkipIntroAt(t: number) {
    if (this.introAutoSkipped) return;
    const m = this.deps.getMarkers();
    if (m.introStart === null || m.introEnd === null) return;
    if (t >= m.introStart && t <= m.introEnd) {
      this.deps.seekTo(m.introEnd);
      this.introAutoSkipped = true;
    }
  }

  private maybeFirePrefetch(t: number) {
    if (this.prefetchFired || this.state !== "idle") return;
    const mode = this.deps.mode?.() ?? "debrid";
    const threshold = mode === "debrid" ? 0.5 : 0.9;
    if (this.duration > 0 && t / this.duration >= threshold) {
      this.prefetchFired = true;
      void this.enterPrefetching();
    }
  }

  private async enterPrefetching() {
    this.state = "prefetching";
    try {
      await this.deps.startPrefetch();
      if (this.state === "prefetching") this.state = "armed";
    } catch (e) {
      this.state = "stopped";
      this.deps.emitToast(`Couldn't load next episode: ${(e as Error).message}`);
    }
  }

  private maybeAdvanceOnCredits(t: number) {
    if (this.state === "advancing" || this.state === "stopped" || this.state === "finale") return;
    const m = this.deps.getMarkers();
    if (m.outroStart !== null && t >= m.outroStart) {
      this.enterAdvancing();
    }
  }

  private async enterAdvancing() {
    const next = this.deps.getNextEpisode();
    if (!next) {
      this.state = "finale";
      this.deps.emitToast("End of series");
      this.deps.exitToShowDetail();
      return;
    }
    this.state = "advancing";
    if (!this.prefetchFired) {
      this.prefetchFired = true;
      this.deps.startPrefetch().catch(() => {});
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await this.deps.pollReady()) {
        await this.deps.loadNextEpisode();
        this.state = "idle";
        this.introAutoSkipped = false;
        this.prefetchFired = false;
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    this.state = "stopped";
    this.deps.emitToast("Couldn't load next episode (timeout)");
  }
}
