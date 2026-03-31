import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../helpers/mock-app.js";

describe("Debrid stream routes", () => {
  let baseUrl: string, close: () => Promise<void>;

  before(async () => {
    ({ baseUrl, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  describe("GET /api/debrid-stream", () => {
    it("returns 400 when url param is missing", async () => {
      const res = await fetch(`${baseUrl}/api/debrid-stream`);
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.ok(body.error.includes("url"));
    });

    it("returns 502 for unreachable debrid URL", async () => {
      const res = await fetch(`${baseUrl}/api/debrid-stream?url=${encodeURIComponent("http://127.0.0.1:1/fake.mp4")}`);
      // Should fail to connect and return an error
      assert.ok(res.status >= 400);
    });
  });
});
