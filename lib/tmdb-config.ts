import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import { configDir } from "./storage/paths.js";

const CONFIG_DIR = configDir();
const CONFIG_PATH = path.join(CONFIG_DIR, "tmdb.json");

interface TmdbConfig { apiKey: string }

export function loadTmdbKey(): string | null {
  if (process.env.TMDB_API_KEY) return process.env.TMDB_API_KEY;
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw) as TmdbConfig;
    return cfg.apiKey || null;
  } catch { return null; }
}

export function saveTmdbKey(apiKey: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify({ apiKey }), { mode: 0o600 });
}

export function deleteTmdbKey(): void {
  try { unlinkSync(CONFIG_PATH); } catch {}
}

export function tmdbConfigured(): boolean {
  return !!loadTmdbKey();
}
