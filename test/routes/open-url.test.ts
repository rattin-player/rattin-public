import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../helpers/mock-app.js";
import type { TestServerResult } from "../helpers/mock-app.js";

describe("POST /api/open-url", () => {
  let srv: TestServerResult;

  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  it("returns 200 for a valid https URL", async () => {
    const res = await fetch(`${srv.baseUrl}/api/open-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=abc" }),
    });
    assert.equal(res.status, 200);
  });

  it("returns 200 for a valid http URL", async () => {
    const res = await fetch(`${srv.baseUrl}/api/open-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://example.com" }),
    });
    assert.equal(res.status, 200);
  });

  it("returns 400 for missing url", async () => {
    const res = await fetch(`${srv.baseUrl}/api/open-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 for non-http URL", async () => {
    const res = await fetch(`${srv.baseUrl}/api/open-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "file:///etc/passwd" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 for javascript: URL", async () => {
    const res = await fetch(`${srv.baseUrl}/api/open-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "javascript:alert(1)" }),
    });
    assert.equal(res.status, 400);
  });
});
