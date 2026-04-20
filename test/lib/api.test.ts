import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchGenres } from "../../src/lib/api.js";

describe("api.get() retry primitive", () => {
  let origFetch: typeof globalThis.fetch;
  let calls: number;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    calls = 0;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("retries exactly once on TypeError (network error)", async () => {
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ genres: [] }), { status: 200 });
    }) as typeof globalThis.fetch;
    const result = await fetchGenres();
    assert.equal(calls, 2, "should have called fetch twice (initial + 1 retry)");
    assert.deepEqual(result, { genres: [] });
  });

  it("does NOT retry on HTTP errors (4xx/5xx)", async () => {
    globalThis.fetch = (async () => {
      calls++;
      return new Response("", { status: 404, statusText: "Not Found" });
    }) as typeof globalThis.fetch;
    await assert.rejects(() => fetchGenres(), /404/);
    assert.equal(calls, 1, "HTTP errors must not trigger a retry");
  });

  it("does NOT retry on non-TypeError exceptions (e.g. AbortError)", async () => {
    globalThis.fetch = (async () => {
      calls++;
      throw new DOMException("aborted", "AbortError");
    }) as typeof globalThis.fetch;
    await assert.rejects(() => fetchGenres());
    assert.equal(calls, 1, "AbortError must not trigger a retry");
  });

  it("gives up after one retry if TypeError persists", async () => {
    globalThis.fetch = (async () => {
      calls++;
      throw new TypeError("Failed to fetch");
    }) as typeof globalThis.fetch;
    await assert.rejects(() => fetchGenres(), TypeError);
    assert.equal(calls, 2, "exactly two total attempts — no unbounded retry");
  });
});
