// lib/torrent-compat.ts
// Adapter for WebTorrent internal APIs used by seek logic.
// All private-API access is isolated here so a WebTorrent upgrade
// only requires updating this file.
//
// Tested against webtorrent@2.x. If an upgrade breaks these,
// grep for "torrent-compat" to find all call sites.

import type { TorrentFile, Torrent } from "./types.js";

/**
 * Get the absolute byte offset of a file within the torrent.
 * WebTorrent 2.x: file.offset (public but undocumented)
 */
export function getFileOffset(file: TorrentFile): number {
  const offset = file.offset;
  if (typeof offset !== "number" || !isFinite(offset)) {
    throw new Error("torrent-compat: file.offset is not a number — WebTorrent API may have changed");
  }
  return offset;
}

/**
 * Get the last piece index for a file.
 * WebTorrent 2.x: file._endPiece (private)
 */
export function getFileEndPiece(file: TorrentFile): number {
  const endPiece = file._endPiece;
  if (typeof endPiece !== "number" || !isFinite(endPiece)) {
    throw new Error("torrent-compat: file._endPiece is not a number — WebTorrent API may have changed");
  }
  return endPiece;
}

/**
 * Check if a specific piece has been downloaded and verified.
 * WebTorrent 2.x: torrent.bitfield.get(index)
 */
export function hasPiece(torrent: Torrent, pieceIndex: number): boolean {
  if (!torrent.bitfield || typeof torrent.bitfield.get !== "function") {
    throw new Error("torrent-compat: torrent.bitfield.get is not available — WebTorrent API may have changed");
  }
  return torrent.bitfield.get(pieceIndex);
}
