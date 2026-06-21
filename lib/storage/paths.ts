import path from "path";
import os from "os";
import { readFileSync } from "fs";

export const isWindows = process.platform === "win32";

export function configDir(): string {
  if (process.env.MAGNET_CONFIG_DIR) return process.env.MAGNET_CONFIG_DIR;
  return isWindows
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Rattin")
    : path.join(os.homedir(), ".config", "rattin");
}

function cacheBase(): string {
  return isWindows ? os.tmpdir() : path.join(os.homedir(), ".cache");
}

export function downloadDir(): string {
  // Check settings file first (read directly to avoid circular import with settings.ts)
  try {
    const settingsPath = path.join(configDir(), "settings.json");
    const raw = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw);
    if (settings.downloadPath) return path.join(settings.downloadPath, "rattin-tmp");
  } catch {}
  return process.env.DOWNLOAD_PATH || path.join(cacheBase(), "rattin");
}

export function transcodeDir(): string {
  return process.env.TRANSCODE_PATH || path.join(cacheBase(), "rattin-transcoded");
}

export function dataDir(profile = "default"): string {
  return path.join(configDir(), "data", profile);
}

export function sessionsPath(): string {
  return path.join(configDir(), "sessions.json");
}

export function rcSessionsPath(): string {
  return path.join(configDir(), "rc-sessions.json");
}

export function learnedOffsetsPath(): string {
  return path.join(configDir(), "learned-offsets.json");
}
