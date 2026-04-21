import type { MarkerSource } from "../types.js";

export interface ChapterInput { time: number; title: string }
export interface AniskipInput { opStart: number; opEnd: number; edStart: number; episodeLength: number }
export interface IntrodbInput {
  introStart: number | null;
  introEnd: number | null;
  outroStart: number | null;
  introSubmissionCount: number;
  outroSubmissionCount: number;
}
export interface LearnedOffsetInput { offset: number; sampleCount: number }

export interface MarkerInputs {
  bridgeHasChapterSupport: boolean;
  chapters: ChapterInput[];
  aniskip: AniskipInput | null;
  introdb: IntrodbInput | null;
  learnedOutroOffset: LearnedOffsetInput | null;
  fileDuration: number;
}

export interface Markers {
  introStart: number | null;
  introEnd: number | null;
  outroStart: number | null;
  introSource: MarkerSource;
  outroSource: MarkerSource;
  outroSampleCount?: number;
}

export const OP_RE = /\b(intro|opening)\b/i;
export const ED_RE = /\b(outro|ending|credits|closing)\b/i;

export function computeMarkers(input: MarkerInputs): Markers {
  if (!input.bridgeHasChapterSupport) {
    return afterChapters(input, {
      introStart: null, introEnd: null, outroStart: null,
      introSource: "bridge missing chapter support",
      outroSource: "bridge missing chapter support",
    });
  }
  if (input.chapters.length > 0) {
    const opIdx = input.chapters.findIndex((c) => OP_RE.test(c.title));
    const edIdx = input.chapters.findIndex((c) => ED_RE.test(c.title));
    const fromChapters = {
      introStart: opIdx >= 0 ? input.chapters[opIdx].time : null,
      introEnd: opIdx >= 0 ? (input.chapters[opIdx + 1]?.time ?? input.fileDuration) : null,
      outroStart: edIdx >= 0 ? input.chapters[edIdx].time : null,
    };
    if (fromChapters.introStart !== null || fromChapters.outroStart !== null) {
      return {
        ...fromChapters,
        introSource: fromChapters.introStart !== null ? "chapter markers" : "no chapter data",
        outroSource: fromChapters.outroStart !== null ? "chapter markers" : "no chapter data",
      };
    }
  }
  return afterChapters(input, {
    introStart: null, introEnd: null, outroStart: null,
    introSource: "no chapter data", outroSource: "no chapter data",
  });
}

function afterChapters(input: MarkerInputs, prior: Markers): Markers {
  let partial = prior;

  if (input.aniskip) {
    const mismatch = Math.abs(input.fileDuration - input.aniskip.episodeLength) > 30;
    if (mismatch) {
      partial = {
        ...partial,
        introSource: "AniSkip · duration mismatch",
        outroSource: "AniSkip · duration mismatch",
      };
    } else {
      // Treat 0 as missing — AniSkip wire format uses 0 as "segment absent" sentinel.
      const opPresent = input.aniskip.opStart > 0 || input.aniskip.opEnd > 0;
      const edPresent = input.aniskip.edStart > 0;
      partial = {
        introStart: opPresent ? input.aniskip.opStart : null,
        introEnd: opPresent ? input.aniskip.opEnd : null,
        outroStart: edPresent ? input.aniskip.edStart : null,
        introSource: opPresent ? "AniSkip · duration OK" : "no AniSkip data",
        outroSource: edPresent ? "AniSkip · duration OK" : "no AniSkip data",
      };
    }
  }

  // IntroDB fills whichever axes are still null (never overrides an already-resolved value
  // or a meaningful source string like "AniSkip · duration mismatch").
  if (input.introdb) {
    const introFromIntrodb = partial.introStart === null
      && input.introdb.introStart !== null
      && input.introdb.introEnd !== null;
    const outroFromIntrodb = partial.outroStart === null
      && input.introdb.outroStart !== null;
    if (introFromIntrodb) {
      partial = {
        ...partial,
        introStart: input.introdb.introStart,
        introEnd: input.introdb.introEnd,
        introSource: "IntroDB · ok",
      };
    }
    if (outroFromIntrodb) {
      partial = {
        ...partial,
        outroStart: input.introdb.outroStart,
        outroSource: "IntroDB · ok",
      };
    }
  }

  // Relabel unresolved fall-through sources so diagnostics reflect the deepest source tried.
  // Only overwrite the generic "no chapter data" / "no AniSkip data" placeholders; preserve
  // specific signals like "AniSkip · duration mismatch" and "bridge missing chapter support".
  const relabelable: MarkerSource[] = ["no chapter data", "no AniSkip data"];
  if (partial.introStart === null && relabelable.includes(partial.introSource)) {
    partial = { ...partial, introSource: "no IntroDB data" };
  }
  if (partial.outroStart === null && relabelable.includes(partial.outroSource)) {
    partial = { ...partial, outroSource: "no IntroDB data" };
  }

  return afterRemote(input, partial);
}

function afterRemote(input: MarkerInputs, prior: Markers): Markers {
  // Preserve pre-existing behavior: learnedOutroOffset, when present, always wins for outro.
  // This is intentional — the learned offset is per-user-per-show and reflects actual viewing.
  if (input.learnedOutroOffset) {
    return {
      ...prior,
      outroStart: input.learnedOutroOffset.offset,
      outroSource: "learned outro offset",
      outroSampleCount: input.learnedOutroOffset.sampleCount,
    };
  }
  if (prior.outroStart === null && prior.outroSource !== "AniSkip · duration mismatch") {
    return { ...prior, outroSource: "no signal — advance on EOF" };
  }
  return prior;
}
