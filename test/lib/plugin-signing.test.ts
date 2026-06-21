// test/lib/plugin-signing.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyPluginSignatureWithKey } from "../../lib/plugins/signing.js";

// Generate an ephemeral test keypair — we're testing the verification LOGIC,
// not the production key. The production key is tested via the plugin repo's CI.
const { publicKey: testPub, privateKey: testPriv } = crypto.generateKeyPairSync("ed25519");
const testPubDer = testPub.export({ type: "spki", format: "der" }) as Buffer;

function signWithTestKey(data: Buffer): Buffer {
  return crypto.sign(null, data, testPriv);
}

describe("verifyPluginSignatureWithKey", () => {
  it("accepts a valid signature from the test key", () => {
    const pluginContent = Buffer.from("// mock plugin content\nconsole.log('hello');\n");
    const signature = signWithTestKey(pluginContent);
    assert.equal(verifyPluginSignatureWithKey(pluginContent, signature, testPubDer), true);
  });

  it("rejects a tampered plugin (signature does not match content)", () => {
    const original = Buffer.from("// original content\n");
    const tampered = Buffer.from("// tampered content\n");
    const signature = signWithTestKey(original);
    assert.equal(verifyPluginSignatureWithKey(tampered, signature, testPubDer), false);
  });

  it("rejects a random 64-byte buffer that is not a valid signature", () => {
    const pluginContent = Buffer.from("// some plugin\n");
    const fakeSignature = crypto.randomBytes(64);
    assert.equal(verifyPluginSignatureWithKey(pluginContent, fakeSignature, testPubDer), false);
  });

  it("rejects a signature from a different key", () => {
    const { publicKey: otherPub, privateKey: otherPriv } = crypto.generateKeyPairSync("ed25519");
    const otherPubDer = otherPub.export({ type: "spki", format: "der" }) as Buffer;
    const pluginContent = Buffer.from("// signed by wrong key\n");
    const signature = crypto.sign(null, pluginContent, otherPriv);
    assert.equal(verifyPluginSignatureWithKey(pluginContent, signature, testPubDer), false);
  });
});
