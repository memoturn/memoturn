import { afterEach, describe, expect, it } from "vitest";
import { type CompiledPrompt, compilePrompt, getPrompt } from "./prompt.js";
import { decodeBasic, mockFetch } from "./test-helpers.js";

const creds = { baseUrl: "http://api.test", publicKey: "pk-mt-x", secretKey: "sk-mt-y" };

let active: ReturnType<typeof mockFetch> | undefined;
afterEach(() => {
  active?.restore();
  active = undefined;
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
