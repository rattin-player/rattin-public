import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { configDir } from "./paths.js";

const SETTINGS_FILE = path.join(configDir(), "settings.json");

export interface AppSettings {
  downloadPath?: string;
}

let cached: AppSettings | null = null;

function load(): AppSettings {
  if (cached) return cached;
  try {
    const raw = readFileSync(SETTINGS_FILE, "utf8");
    cached = JSON.parse(raw) as AppSettings;
  } catch {
    cached = {};
  }
  return cached!;
}

export function getSettings(): AppSettings {
  return { ...load() };
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return load()[key];
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = load();
  const merged = { ...current, ...patch };
  mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), "utf8");
  cached = merged;
  return { ...merged };
}
