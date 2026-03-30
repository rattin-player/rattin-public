// lib/torrent-compat.js
// Adapter for WebTorrent internal APIs used by seek logic.
// All private-API access is isolated here so a WebTorrent upgrade
// only requires updating this file.
//
// Tested against webtorrent@2.x. If an upgrade breaks these,
// grep for "torrent-compat" to find all call sites.

/**
 * Get the absolute byte offset of a file within the torrent.
 * WebTorrent 2.x: file.offset (public but undocumented)
 * @param {object} file - WebTorrent File instance
 * @returns {number}
 */
export function getFileOffset(file) {
  const offset = file.offset;
  if (typeof offset !== "number" || !isFinite(offset)) {
    throw new Error("torrent-compat: file.offset is not a number — WebTorrent API may have changed");
  }
  return offset;
}

/**
 * Get the last piece index for a file.
 * WebTorrent 2.x: file._endPiece (private)
 * @param {object} file - WebTorrent File instance
 * @returns {number}
 */
export function getFileEndPiece(file) {
  const endPiece = file._endPiece;
  if (typeof endPiece !== "number" || !isFinite(endPiece)) {
    throw new Error("torrent-compat: file._endPiece is not a number — WebTorrent API may have changed");
  }
  return endPiece;
}

/**
 * Check if a specific piece has been downloaded and verified.
 * WebTorrent 2.x: torrent.bitfield.get(index)
 * @param {object} torrent - WebTorrent Torrent instance
 * @param {number} pieceIndex
 * @returns {boolean}
 */
export function hasPiece(torrent, pieceIndex) {
  if (!torrent.bitfield || typeof torrent.bitfield.get !== "function") {
    throw new Error("torrent-compat: torrent.bitfield.get is not available — WebTorrent API may have changed");
  }
  return torrent.bitfield.get(pieceIndex);
}
