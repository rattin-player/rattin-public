export interface ParsedMagnet {
  infoHash: string;
  name: string;
}

/**
 * Parse a magnet URI into its infoHash and display name.
 * Returns null if the input is not a valid magnet with a btih hash.
 */
export function parseMagnet(uri: string): ParsedMagnet | null {
  if (!uri.startsWith("magnet:?")) return null;

  // URLSearchParams can't parse magnet: scheme directly — strip the scheme part
  const params = new URLSearchParams(uri.slice("magnet:?".length));

  const xt = params.get("xt");
  if (!xt || !xt.startsWith("urn:btih:")) return null;

  const infoHash = xt.slice("urn:btih:".length).toLowerCase();
  if (!infoHash) return null;

  const dn = params.get("dn");
  const name = dn ? decodeURIComponent(dn.replace(/\+/g, " ")) : infoHash;

  return { infoHash, name };
}
