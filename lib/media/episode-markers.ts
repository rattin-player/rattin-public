import type { MarkerSource } from "../types.js";

export interface ChapterInput { time: number; title: string }
export interface AniskipInput { opStart: number; opEnd: number; edStart: number; episodeLength: number }
export interface LearnedOffsetInput { offset: number; sampleCount: number }

export interface MarkerInputs {
  bridgeHasChapterSupport: boolean;
  chapters: ChapterInput[];
  aniskip: AniskipInput | null;
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

const OP_RE = /\b(intro|opening)\b/i;
const ED_RE = /\b(outro|ending|credits|closing|\bend\b)\b/i;

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
  if (input.aniskip) {
    const mismatch = Math.abs(input.fileDuration - input.aniskip.episodeLength) > 30;
    if (mismatch) {
      return afterAniskip(input, {
        ...prior,
        introSource: "AniSkip · duration mismatch",
        outroSource: "AniSkip · duration mismatch",
      });
    }
    return {
      introStart: input.aniskip.opStart,
      introEnd: input.aniskip.opEnd,
      outroStart: input.aniskip.edStart,
      introSource: "AniSkip · duration OK",
      outroSource: "AniSkip · duration OK",
    };
  }
  return afterAniskip(input, {
    ...prior,
    introSource: prior.introSource !== "no chapter data" ? prior.introSource : "no AniSkip data",
    outroSource: prior.outroSource !== "no chapter data" ? prior.outroSource : "no AniSkip data",
  });
}

function afterAniskip(input: MarkerInputs, prior: Markers): Markers {
  if (input.learnedOutroOffset) {
    return {
      ...prior,
      outroStart: input.learnedOutroOffset.offset,
      outroSource: "learned outro offset",
      outroSampleCount: input.learnedOutroOffset.sampleCount,
    };
  }
  return {
    ...prior,
    outroSource: "no signal — advance on EOF",
  };
}
