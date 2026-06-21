import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { rcSessionsPath } from "./paths.js";
import type { RCSession } from "../types.js";

const RC_SESSIONS_PATH = rcSessionsPath();

interface RCSessionEntry { sessionId: string; authToken: string; pairingCode?: string }

export function dumpRcSessions(rcSessions: Map<string, RCSession>): void {
  try {
    let best: RCSessionEntry | null = null;
    let bestActivity = 0;
    for (const [sessionId, s] of rcSessions) {
      if (!s.authToken) continue;
      if (s.lastActivity >= bestActivity) {
        best = { sessionId, authToken: s.authToken, pairingCode: s.pairingCode };
        bestActivity = s.lastActivity;
      }
    }
    const entries = best ? [best] : [];
    mkdirSync(path.dirname(RC_SESSIONS_PATH), { recursive: true });
    writeFileSync(RC_SESSIONS_PATH, JSON.stringify(entries));
  } catch {}
}

export function restoreRcSessions(rcSessions: Map<string, RCSession>): void {
  try {
    const raw = readFileSync(RC_SESSIONS_PATH, "utf8");
    const entries = JSON.parse(raw) as RCSessionEntry[];
    for (const e of entries) {
      if (e.sessionId && e.authToken && !rcSessions.has(e.sessionId)) {
        rcSessions.set(e.sessionId, {
          playerClient: null,
          remoteClients: [],
          playbackState: null,
          lastActivity: Date.now(),
          authToken: e.authToken,
          pairingCode: e.pairingCode,
          bingeMode: { enabled: false, capabilities: null, persistedTracks: { audio: null, subtitles: null }, diagnostics: null },
        });
      }
    }
  } catch {}
}
