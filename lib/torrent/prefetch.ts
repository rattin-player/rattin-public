export interface NextEp { tmdbId: string; season: number; episode: number }
export interface Resolved { infoHash: string; fileIndex: number; magnet: string }

export interface PrefetchDeps {
  resolveNext: (nextEp: NextEp) => Promise<Resolved>;
  warmCache: (magnet: string) => Promise<void>;
  addTorrent: (magnet: string, fileIndex: number) => Promise<void>;
  isFinished: (tmdbId: string, season: number, episode: number) => boolean | Promise<boolean>;
}

export interface PrefetchArgs {
  mode: "debrid" | "native";
  nextEp: NextEp;
  currentInfoHash?: string;
  deps: PrefetchDeps;
}

export async function startPrefetch(args: PrefetchArgs): Promise<Resolved | null> {
  if (await args.deps.isFinished(args.nextEp.tmdbId, args.nextEp.season, args.nextEp.episode)) {
    return null;
  }
  const resolved = await args.deps.resolveNext(args.nextEp);
  if (!resolved.infoHash || !resolved.magnet) return null;
  // Same-hash means the next episode is in the current season-pack torrent —
  // pieces are already being fetched, so no warm/add is needed.
  if (args.currentInfoHash && args.currentInfoHash === resolved.infoHash) {
    return resolved;
  }
  if (args.mode === "debrid") {
    await args.deps.warmCache(resolved.magnet);
  } else {
    await args.deps.addTorrent(resolved.magnet, resolved.fileIndex);
  }
  return resolved;
}

export async function isDebridCached(
  poll: () => Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 1_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await poll()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}
