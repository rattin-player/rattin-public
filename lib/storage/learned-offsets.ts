import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { LearnedOffsetSample } from "../types.js";
import { learnedOffsetsPath } from "./paths.js";

interface StoreData {
  [tmdbId: string]: { outro_samples: LearnedOffsetSample[] };
}

export class LearnedOffsetsStore {
  private data: StoreData = {};
  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      try { this.data = JSON.parse(readFileSync(filePath, "utf-8")); } catch { this.data = {}; }
    }
  }

  addOutroSample(tmdbId: string, sample: LearnedOffsetSample): void {
    if (!this.data[tmdbId]) this.data[tmdbId] = { outro_samples: [] };
    this.data[tmdbId].outro_samples.push(sample);
    this.persist();
  }

  getOutroOffset(tmdbId: string): { offset: number; sampleCount: number } | null {
    const samples = this.data[tmdbId]?.outro_samples ?? [];
    if (samples.length < 2) return null;
    const offsets = samples.map((s) => s.offset).sort((a, b) => a - b);
    const spread = offsets[offsets.length - 1] - offsets[0];
    if (spread > 3) return null;
    const mid = Math.floor(offsets.length / 2);
    const median = offsets.length % 2
      ? offsets[mid]
      : (offsets[mid - 1] + offsets[mid]) / 2;
    return { offset: median, sampleCount: samples.length };
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}

let _instance: LearnedOffsetsStore | null = null;
export function getStore(): LearnedOffsetsStore {
  if (!_instance) _instance = new LearnedOffsetsStore(learnedOffsetsPath());
  return _instance;
}
