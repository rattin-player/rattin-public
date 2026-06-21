// lib/plugins/pubkey.ts
// Production Ed25519 public key (DER-encoded SPKI, base64).
// The matching private key is stored as the GitHub Actions secret PLUGIN_SIGNING_PRIVATE_KEY.
// NEVER commit the private key to any repo.

const PUBKEY_BASE64 = "MCowBQYDK2VwAyEALqlwQvqW6gA3nvN6s5kes6kcy0e+CfeKoTIZCAOEOsQ=";

export const PLUGIN_PUBKEY_DER = Buffer.from(PUBKEY_BASE64, "base64");
