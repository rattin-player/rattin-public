import path from "path";
import os from "os";

export const isWindows = process.platform === "win32";

export function configDir(): string {
  if (process.env.MAGNET_CONFIG_DIR) return process.env.MAGNET_CONFIG_DIR;
  return isWindows
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Rattin")
    : path.join(os.homedir(), ".config", "rattin");
}

export function downloadDir(): string {
  return process.env.DOWNLOAD_PATH || path.join(os.tmpdir(), "rattin");
}

export function transcodeDir(): string {
  return process.env.TRANSCODE_PATH || path.join(os.tmpdir(), "rattin-transcoded");
}

export function sessionsPath(): string {
  return path.join(configDir(), "sessions.json");
}
