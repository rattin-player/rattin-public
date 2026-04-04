import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import path from "path";

/**
 * Generic JSON-backed persistent store.
 * In-memory Map with debounced atomic writes to disk.
 */
export class JsonStore<T> {
  private data = new Map<string, T>();
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly filePath: string;

  constructor(filePath: string, flushInterval = 5000) {
    this.filePath = filePath;
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
    this.timer = setInterval(() => this.flushIfDirty(), flushInterval);
    if (this.timer.unref) this.timer.unref();
  }

  get(key: string): T | undefined {
    return this.data.get(key);
  }

  set(key: string, value: T): void {
    this.data.set(key, value);
    this.dirty = true;
  }

  delete(key: string): boolean {
    const existed = this.data.delete(key);
    if (existed) this.dirty = true;
    return existed;
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  values(): T[] {
    return [...this.data.values()];
  }

  entries(): [string, T][] {
    return [...this.data.entries()];
  }

  query(predicate: (value: T, key: string) => boolean): T[] {
    const results: T[] = [];
    for (const [key, value] of this.data) {
      if (predicate(value, key)) results.push(value);
    }
    return results;
  }

  get size(): number {
    return this.data.size;
  }

  /** Immediately write to disk. */
  flush(): void {
    if (!this.dirty) return;
    this.writeToDisk();
  }

  /** Flush and stop the timer. Call on shutdown. */
  shutdown(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.dirty) this.writeToDisk();
  }

  private flushIfDirty(): void {
    if (this.dirty) this.writeToDisk();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) {
          this.data.set(k, v as T);
        }
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }

  private writeToDisk(): void {
    const obj: Record<string, T> = {};
    for (const [k, v] of this.data) obj[k] = v;
    const json = JSON.stringify(obj, null, 2);
    const tmp = this.filePath + ".tmp";
    try {
      writeFileSync(tmp, json, "utf8");
      renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (err) {
      console.error(`[JsonStore] Failed to write ${this.filePath}:`, err);
    }
  }
}
