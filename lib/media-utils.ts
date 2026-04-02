import path from "path";

export const VIDEO_EXTENSIONS: string[] = [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".ts", ".flv", ".wmv"];
export const AUDIO_EXTENSIONS: string[] = [".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".wav", ".wma"];
export const SUBTITLE_EXTENSIONS: string[] = [".srt", ".ass", ".ssa", ".vtt", ".sub"];
export const ALLOWED_EXTENSIONS: Set<string> = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...SUBTITLE_EXTENSIONS]);

export function isAllowedFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

// Simple SRT to VTT converter
export function srtToVtt(srt: string): string {
  let vtt = "WEBVTT\n\n";
  // Normalize line endings and split into blocks
  const blocks = srt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n");
    // Find the timestamp line (contains " --> ")
    const tsIdx = lines.findIndex((l) => l.includes(" --> "));
    if (tsIdx === -1) continue;
    // Convert commas to dots in timestamps (SRT uses commas, VTT uses dots)
    const timestamp = lines[tsIdx].replace(/,/g, ".");
    const text = lines.slice(tsIdx + 1).join("\n");
    if (text.trim()) {
      vtt += timestamp + "\n" + text + "\n\n";
    }
  }
  return vtt;
}

export function magnetToInfoHash(magnet: string): string | null {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40})/);
  return m ? m[1].toLowerCase() : null;
}

export function fmtBytes(b: number): string {
  if (b === 0) return "0 B";
  const k = 1024, s = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + " " + s[i];
}

export function throttle(fn: (...args: unknown[]) => void, ms: number): (...args: unknown[]) => void {
  let last = 0;
  return (...a: unknown[]) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...a); } };
}
