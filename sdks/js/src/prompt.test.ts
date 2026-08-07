import { afterEach, describe, expect, it, vi } from "vitest";
import { type CompiledPrompt, clearPromptCache, compilePrompt, getPrompt } from "./prompt.js";
import { decodeBasic, mockFetch } from "./test-helpers.js";

const creds = { baseUrl: "http://api.test", publicKey: "pk-mt-x", secretKey: "sk-mt-y" };

let active: ReturnType<typeof mockFetch> | undefined;
afterEach(() => {
  active?.restore();
  active = undefined;
  // The prompt cache is module-level state — leaking it across tests would make them order-dependent.
  clearPromptCache();
  vi.useRealTimers();
});

const promptOf = (over: Partial<CompiledPrompt> = {}): CompiledPrompt => ({
  name: "greet",
  version: 1,
  type: "TEXT",
  content: "hi",
  config: {},
  ...over,
});

describe("getPrompt", () => {
  it("GETs /v1/prompts/:name with the channel query and Basic auth", async () => {
    const payload: CompiledPrompt = { name: "greet", version: 3, type: "TEXT", content: "hi", config: {} };
    active = mockFetch(() => ({ json: payload }));
    const out = await getPrompt(creds, "greet");

    expect(active.calls).toHaveLength(1);
    const req = active.calls[0];
    expect(req.method).toBe("GET");
    expect(req.url).toBe("http://api.test/v1/prompts/greet?channel=production");
    expect(decodeBasic(req.headers.authorization)).toBe("pk-mt-x:sk-mt-y");
    expect(out).toEqual(payload);
  });

  it("honors a custom channel and url-encodes the name", async () => {
    active = mockFetch(() => ({ json: { name: "a/b", version: 1, type: "TEXT", content: "", config: {} } }));
    await getPrompt(creds, "a/b", { channel: "staging" });
    expect(active.calls[0].url).toBe("http://api.test/v1/prompts/a%2Fb?channel=staging");
  });

  it("throws with status + body on a non-2xx response", async () => {
    active = mockFetch(() => ({ status: 404, text: "not found" }));
    await expect(getPrompt(creds, "missing")).rejects.toThrow(/getPrompt failed: 404 not found/);
  });
});

describe("getPrompt caching", () => {
  it("serves a fresh hit from memory without a second request", async () => {
    active = mockFetch(() => ({ json: promptOf() }));
    await getPrompt(creds, "greet");
    const out = await getPrompt(creds, "greet");
    expect(active.calls).toHaveLength(1);
    expect(out).toEqual(promptOf());
  });

  it("keys the cache by channel and bucketKey so A/B arms don't bleed into each other", async () => {
    active = mockFetch((req) => ({ json: promptOf({ version: req.url.includes("bucketKey=u2") ? 2 : 1 }) }));
    const a = await getPrompt(creds, "greet", { bucketKey: "u1" });
    const b = await getPrompt(creds, "greet", { bucketKey: "u2" });
    const c = await getPrompt(creds, "greet", { channel: "staging", bucketKey: "u1" });
    expect([a.version, b.version]).toEqual([1, 2]);
    expect(active.calls).toHaveLength(3); // three distinct keys, three fetches
    // ...and each is independently cached.
    await getPrompt(creds, "greet", { bucketKey: "u2" });
    expect(active.calls).toHaveLength(3);
    expect(c.version).toBe(1);
  });

  it("refetches once the TTL expires", async () => {
    vi.useFakeTimers();
    let version = 1;
    active = mockFetch(() => ({ json: promptOf({ version: version++ }) }));
    expect((await getPrompt(creds, "greet", { cacheTtlMs: 1000 })).version).toBe(1);
    vi.advanceTimersByTime(1500);
    // Stale-while-revalidate: the STALE value is returned now and a refresh runs behind it.
    expect((await getPrompt(creds, "greet", { cacheTtlMs: 1000 })).version).toBe(1);
    await vi.waitFor(() => expect(active?.calls).toHaveLength(2));
    // The refresh has landed, so the next resolve sees the new version.
    expect((await getPrompt(creds, "greet", { cacheTtlMs: 1000 })).version).toBe(2);
  });

  it("bypasses the cache entirely when cacheTtlMs is 0", async () => {
    active = mockFetch(() => ({ json: promptOf() }));
    await getPrompt(creds, "greet", { cacheTtlMs: 0 });
    await getPrompt(creds, "greet", { cacheTtlMs: 0 });
    expect(active.calls).toHaveLength(2);
  });

  it("coalesces concurrent misses into a single request", async () => {
    active = mockFetch(() => ({ json: promptOf() }));
    const [a, b, c] = await Promise.all([
      getPrompt(creds, "greet"),
      getPrompt(creds, "greet"),
      getPrompt(creds, "greet"),
    ]);
    expect(active.calls).toHaveLength(1);
    expect([a, b, c]).toEqual([promptOf(), promptOf(), promptOf()]);
  });
});

describe("getPrompt outage behavior", () => {
  it("keeps serving the stale prompt when a refresh fails", async () => {
    vi.useFakeTimers();
    let fail = false;
    active = mockFetch(() => (fail ? { status: 503, text: "down" } : { json: promptOf({ version: 7 }) }));
    expect((await getPrompt(creds, "greet", { cacheTtlMs: 1000 })).version).toBe(7);

    fail = true;
    vi.advanceTimersByTime(5000);
    // A memoturn outage must not take down the app that depends on it.
    expect((await getPrompt(creds, "greet", { cacheTtlMs: 1000 })).version).toBe(7);
    expect((await getPrompt(creds, "greet", { cacheTtlMs: 1000 })).version).toBe(7);
  });

  it("returns the fallback when the fetch fails and nothing is cached", async () => {
    active = mockFetch(() => ({ status: 500, text: "boom" }));
    const fallback = promptOf({ content: "local default" });
    expect(await getPrompt(creds, "greet", { fallback })).toEqual(fallback);
  });

  it("still throws when the fetch fails with no cache and no fallback", async () => {
    active = mockFetch(() => ({ status: 500, text: "boom" }));
    await expect(getPrompt(creds, "greet")).rejects.toThrow(/getPrompt failed: 500/);
  });

  it("prefers a cached value over the fallback", async () => {
    vi.useFakeTimers();
    let fail = false;
    active = mockFetch(() => (fail ? { status: 503, text: "down" } : { json: promptOf({ content: "from server" }) }));
    await getPrompt(creds, "greet", { cacheTtlMs: 1000 });

    fail = true;
    vi.advanceTimersByTime(5000);
    const out = await getPrompt(creds, "greet", { cacheTtlMs: 1000, fallback: promptOf({ content: "local default" }) });
    expect(out.content).toBe("from server");
  });
});

describe("compilePrompt", () => {
  it("fills {{vars}} in a TEXT prompt and leaves unknown placeholders intact", () => {
    const prompt: CompiledPrompt = {
      name: "p",
      version: 1,
      type: "TEXT",
      content: "Hi {{name}}, {{missing}}",
      config: {},
    };
    expect(compilePrompt(prompt, { name: "Ada" })).toBe("Hi Ada, {{missing}}");
  });

  it("fills each message of a CHAT prompt", () => {
    const prompt: CompiledPrompt = {
      name: "p",
      version: 1,
      type: "CHAT",
      content: [
        { role: "system", content: "You are {{persona}}." },
        { role: "user", content: "Count to {{n}}." },
      ],
      config: {},
    };
    expect(compilePrompt(prompt, { persona: "terse", n: 3 })).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "Count to 3." },
    ]);
  });

  it("coerces numeric vars and tolerates surrounding whitespace in the tag", () => {
    const prompt: CompiledPrompt = { name: "p", version: 1, type: "TEXT", content: "n={{ count }}", config: {} };
    expect(compilePrompt(prompt, { count: 42 })).toBe("n=42");
  });
});
