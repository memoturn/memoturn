// Unit tests for the retry layer + error envelope — injected fetch, no node.
// Run: node test/retry.test.mjs (after npm run build)
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { memoturn, MemoturnError } from "../dist/index.js";

const ok = (body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Memoturn-Txid": "1", ...headers },
  });

const err = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function client(responses, opts = {}) {
  const calls = { n: 0 };
  const fetch = async () => {
    const r = responses[Math.min(calls.n, responses.length - 1)];
    calls.n++;
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r() : r;
  };
  return { mt: memoturn({ fetch, ...opts }), calls };
}

test("503 retries then succeeds", async () => {
  const { mt, calls } = client([
    () => err(503, { error: "unavailable", code: "unavailable" }),
    () => ok({ databases: [] }),
  ]);
  await mt.databases.list();
  assert.equal(calls.n, 2);
});

test("network error retries", async () => {
  const { mt, calls } = client([new TypeError("fetch failed"), () => ok({ databases: [] })]);
  await mt.databases.list();
  assert.equal(calls.n, 2);
});

test("429 honors Retry-After and surfaces overloaded after exhaustion", async () => {
  const { mt, calls } = client(
    [() => err(429, { error: "shed", code: "overloaded" }, { "Retry-After": "0" })],
    { retries: 1 },
  );
  const t0 = Date.now();
  await assert.rejects(
    () => mt.databases.list(),
    (e) => e instanceof MemoturnError && e.status === 429 && e.code === "overloaded",
  );
  assert.equal(calls.n, 2);
  assert.ok(Date.now() - t0 >= 200, "backoff applied");
});

test("plain 500 and 4xx never retry", async () => {
  for (const [status, code] of [
    [500, "internal"],
    [404, "branch_not_found"],
    [400, "invalid_request"],
  ]) {
    const { mt, calls } = client([() => err(status, { error: "boom", code })]);
    await assert.rejects(
      () => mt.databases.list(),
      (e) => e instanceof MemoturnError && e.code === code,
    );
    assert.equal(calls.n, 1, `status ${status} must not retry`);
  }
});

test("retries: 0 disables retries entirely", async () => {
  const { mt, calls } = client([() => err(503, { error: "down", code: "unavailable" })], {
    retries: 0,
  });
  await assert.rejects(() => mt.databases.list());
  assert.equal(calls.n, 1);
});

test("envelope-less 413 falls back to a status-derived code", async () => {
  const { mt } = client([
    () => new Response("", { status: 413 }), // tower default: empty body
  ]);
  await assert.rejects(
    () => mt.databases.list(),
    (e) => e instanceof MemoturnError && e.code === "payload_too_large",
  );
});
