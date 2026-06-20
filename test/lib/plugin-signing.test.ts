// test/lib/plugin-signing.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyPluginSignature } from "../../lib/plugins/signing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devKeyJson = JSON.parse(
  readFileSync(path.join(__dirname, "..", "fixtures", "dev-private-key.json"), "utf8")
) as { base64: string; format: "der"; type: "pkcs8" };

function signWithDevKey(data: Buffer): Buffer {
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(devKeyJson.base64, "base64"),
    format: devKeyJson.format,
    type: devKeyJson.type,
  });
  return crypto.sign(null, data, privKey);
}

describe("verifyPluginSignature", () => {
  it("accepts a valid signature from the dev key", () => {
    const pluginContent = Buffer.from("// mock plugin content\nconsole.log('hello');\n");
    const signature = signWithDevKey(pluginContent);
    assert.equal(verifyPluginSignature(pluginContent, signature), true);
  });

  it("rejects a tampered plugin (signature does not match content)", () => {
    const original = Buffer.from("// original content\n");
    const tampered = Buffer.from("// tampered content\n");
    const signature = signWithDevKey(original);
    assert.equal(verifyPluginSignature(tampered, signature), false);
  });

  it("rejects a random 64-byte buffer that is not a valid signature", () => {
    const pluginContent = Buffer.from("// some plugin\n");
    const fakeSignature = crypto.randomBytes(64);
    assert.equal(verifyPluginSignature(pluginContent, fakeSignature), false);
  });
});
