import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../helpers/mock-app.js";

function remoteHeaders(cookie?: string): HeadersInit {
  return {
    "X-Forwarded-For": "203.0.113.10",
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

describe("API access control", () => {
  let baseUrl: string, close: () => Promise<void>;

  before(async () => {
    ({ baseUrl, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  it("rejects unauthenticated non-local API requests", async () => {
    const res = await fetch(`${baseUrl}/api/tmdb/status`, {
      headers: remoteHeaders(),
    });
    assert.equal(res.status, 401);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "remote_auth_required");
  });

  it("allows authenticated non-local remote-safe API requests", async () => {
    const createRes = await fetch(`${baseUrl}/api/rc/session`, { method: "POST" });
    const { sessionId, authToken } = await createRes.json() as { sessionId: string; authToken: string };

    const res = await fetch(`${baseUrl}/api/tmdb/status`, {
      headers: remoteHeaders(`rc_session=${sessionId}; rc_token=${authToken}`),
    });
    assert.equal(res.status, 200);
  });

  it("blocks authenticated non-local access to local-only API routes", async () => {
    const createRes = await fetch(`${baseUrl}/api/rc/session`, { method: "POST" });
    const { sessionId, authToken } = await createRes.json() as { sessionId: string; authToken: string };

    const res = await fetch(`${baseUrl}/api/debrid/status`, {
      headers: remoteHeaders(`rc_session=${sessionId}; rc_token=${authToken}`),
    });
    assert.equal(res.status, 403);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "local_only");
  });
});
