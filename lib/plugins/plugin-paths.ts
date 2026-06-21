// lib/plugins/plugin-paths.ts
import path from "path";
import { configDir } from "../storage/paths.js";

export function pluginDir(): string {
  return path.join(configDir(), "plugins");
}

export function pluginMetaPath(): string {
  return path.join(pluginDir(), "plugin-meta.json");
}
