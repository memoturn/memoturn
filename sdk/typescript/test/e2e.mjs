// SDK e2e against a live memoturnd. Requires:
//   MEMOTURN_URL (default http://127.0.0.1:8080)
//   MEMOTURN_PLATFORM_KEY (auth on) — or a node with auth disabled.
// Run: npm test   (from sdk/typescript, with a node up)
import assert from "node:assert/strict";
import { memoturn } from "../dist/index.js";

const url = process.env.MEMOTURN_URL ?? "http://127.0.0.1:8080";
const platformKey = process.env.MEMOTURN_PLATFORM_KEY;
const ns = `sdk${Date.now() % 100000}`;

const platform = memoturn({ url, platformKey });
const token = platformKey ? await platform.createNamespaceToken(ns, "admin") : undefined;
const mt = memoturn({ url, token, platformKey });
const alice = mt.memory(ns, "alice");

// ingest: created → duplicate → supersession
let r = await alice.ingest([
  {
    type: "fact",
    topicKey: "user.diet",
    summary: "vegetarian since 2024",
    content: { diet: "vegetarian" },
    keywords: "food preference",
    embedding: [1, 0],
  },
  { type: "event", summary: "ordered a salad", content: { order: 17 }, embedding: [0, 1] },
  { type: "task", summary: "confirm allergy info", content: {}, sessionId: "s-1" },
]);
assert.equal(r.results.length, 3);
assert.ok(r.results.every((x) => x.status === "created"));
const dietId = r.results[0].id;

r = await alice.ingest([
  {
    type: "fact",
    topicKey: "user.diet",
    summary: "vegetarian since 2024",
    content: { diet: "vegetarian" },
    embedding: [1, 0],
  },
]);
assert.equal(r.results[0].status, "duplicate");

r = await alice.ingest([
  {
    type: "fact",
    topicKey: "user.diet",
    summary: "vegan since 2026",
    content: { diet: "vegan" },
    keywords: "food preference",
    embedding: [0.9, 0.1],
  },
]);
assert.deepEqual(r.results[0].superseded, [dietId]);

// recall: keyword channel hides superseded; chain visible via get()
const { memories } = await alice.recall({ query: "what food preference?" });
assert.equal(memories[0].summary, "vegan since 2026");
assert.ok(memories[0].channels.includes("keyword"));
assert.ok(!memories.some((m) => m.id === dietId));
const old = await alice.get(dietId);
assert.equal(old.superseded_by, r.results[0].id);

// vector channel
const byVec = await alice.recall({ embedding: [0.1, 0.9], k: 1 });
assert.equal(byVec.memories[0].summary, "ordered a salad");

// ask: answer synthesis when the node has an assistant; clean 503 otherwise
try {
  const asked = await alice.ask("what is the user's food preference?");
  assert.equal(typeof asked.answer, "string");
  assert.ok(Array.isArray(asked.sources));
  assert.ok(asked.memories.some((m) => m.summary === "vegan since 2026"));
  console.log("ask: assistant answered");
} catch (e) {
  assert.equal(e.status, 503, `ask must 503 cleanly when unconfigured, got: ${e}`);
  console.log("ask: node has no assistant (503) — skipped");
}

// sessions + transcript layer
assert.deepEqual((await alice.sessions()).map((s) => s.id), ["s-1"]);
const t = alice.session("s-1");
await t.appendTurn({ role: "user", content: { text: "I'm vegan now" } });
assert.equal((await t.getWindow({ last: 5 })).length, 1);
await alice.endSession("s-1", { turns: true });
assert.deepEqual(await alice.sessions(), []);

// checkpoint → learn garbage → rewind the mind (admin)
await alice.checkpoint("sane");
await alice.ingest([
  { type: "fact", topicKey: "user.diet", summary: "eats only concrete", content: { diet: "?" } },
]);
await alice.rewind("sane");
const after = await alice.recall({ topicKey: "user.diet" });
assert.equal(after.memories[0].summary, "vegan since 2026");

// forget is the only hard delete
assert.equal(await alice.forget(after.memories[0].id), true);
assert.equal(await alice.forget(after.memories[0].id), false);

// namespace listing (ns token) + substrate smoke (kv via the profile db)
if (token) {
  const profiles = await mt.profiles(ns);
  assert.deepEqual(profiles.map((p) => p.profile), ["alice"]);
}
const db = mt.db(`${ns}--alice`);
await db.kv.put("scratch", "plan", "step 1");
assert.equal(await db.kv.get("scratch", "plan"), "step 1");

console.log("sdk e2e: ok");
