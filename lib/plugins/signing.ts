// lib/plugins/signing.ts
import crypto from "node:crypto";
import { PLUGIN_PUBKEY_DER } from "./pubkey.js";

/**
 * Verify that a plugin file was signed by the trusted publisher.
 * Uses Ed25519 via Node's built-in crypto (no external dependencies).
 *
 * @param pluginBuffer - The raw plugin file content
 * @param signatureBuffer - The 64-byte Ed25519 signature
 * @returns true if the signature is valid for this content and key
 */
export function verifyPluginSignature(pluginBuffer: Buffer, signatureBuffer: Buffer): boolean {
  try {
    const publicKey = crypto.createPublicKey({
      key: PLUGIN_PUBKEY_DER,
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, pluginBuffer, publicKey, signatureBuffer);
  } catch {
    return false;
  }
}
