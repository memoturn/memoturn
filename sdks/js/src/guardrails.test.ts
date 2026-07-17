import { afterEach, describe, expect, it, vi } from "vitest";
import { checkGuardrails, GuardrailBlockedError, type GuardrailVerdict, runGuarded } from "./guardrails.js";
import { mockFetch } from "./test-helpers.js";

const creds = { baseUrl: "http://api.test", publicKey: "pk-mt-x", secretKey: "sk-mt-y" };

let active: ReturnType<typeof mockFetch> | undefined;
afterEach(() => {
  active?.restore();
  active = undefined;
});

const blockVerdict: GuardrailVerdict = {
  verdict: "block",
  findings: [{ category: "pii", type: "email", count: 1 }],
};

const allowVerdict: GuardrailVerdict = { verdict: "allow", findings: [] };

describe("checkGuardrails", () => {
  it("POSTs the text to /v1/guardrails/check and returns the verdict", async () => {
    active = mockFetch(() => ({ json: allowVerdict }));
    const verdict = await checkGuardrails(creds, "hello");
    expect(active.calls[0].url).toBe("http://api.test/v1/guardrails/check");
    expect(active.calls[0].body).toEqual({ text: "hello" });
    expect(verdict).toEqual(allowVerdict);
  });
});

describe("runGuarded", () => {
  it("returns the result unchanged on an allow verdict", async () => {
    active = mockFetch(() => ({ json: allowVerdict }));
    const result = await runGuarded(() => "safe text", { creds });
    expect(result).toBe("safe text");
  });

  it("returns the result unchanged on a redact verdict (content substitution is the server's job)", async () => {
    active = mockFetch(() => ({ json: { verdict: "redact", findings: [], redactedText: "***" } }));
    const result = await runGuarded(() => "my email is a@b.com", { creds });
    expect(result).toBe("my email is a@b.com");
  });

  it('default onFailure "raise" throws GuardrailBlockedError on a block verdict', async () => {
    active = mockFetch(() => ({ json: blockVerdict }));
    await expect(runGuarded(() => "blocked text", { creds })).rejects.toThrow(GuardrailBlockedError);
  });

  it('onFailure "raise" error carries the verdict and mentions the finding types', async () => {
    active = mockFetch(() => ({ json: blockVerdict }));
    try {
      await runGuarded(() => "blocked text", { creds, onFailure: "raise" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GuardrailBlockedError);
      expect((err as GuardrailBlockedError).verdict).toEqual(blockVerdict);
      expect((err as GuardrailBlockedError).message).toContain("email");
    }
  });

  it('onFailure "log" warns and returns the original result on a block verdict', async () => {
    active = mockFetch(() => ({ json: blockVerdict }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await runGuarded(() => "blocked text", { creds, onFailure: "log" });
    expect(result).toBe("blocked text");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("onFailure { fallback: value } returns the static fallback on a block verdict", async () => {
    active = mockFetch(() => ({ json: blockVerdict }));
    const result = await runGuarded(() => "blocked text", { creds, onFailure: { fallback: "[redacted]" } });
    expect(result).toBe("[redacted]");
  });

  it("onFailure { fallback: fn } calls the function with the verdict and returns its result", async () => {
    active = mockFetch(() => ({ json: blockVerdict }));
    const fallback = vi.fn((verdict: GuardrailVerdict) => `blocked: ${verdict.findings[0]?.type}`);
    const result = await runGuarded(() => "blocked text", { creds, onFailure: { fallback } });
    expect(result).toBe("blocked: email");
    expect(fallback).toHaveBeenCalledWith(blockVerdict);
  });

  it("uses extractText to scan a non-string result", async () => {
    active = mockFetch(() => ({ json: allowVerdict }));
    const result = await runGuarded(() => ({ answer: "hi" }), {
      creds,
      extractText: (r) => r.answer,
    });
    expect(active.calls[0].body).toEqual({ text: "hi" });
    expect(result).toEqual({ answer: "hi" });
  });

  it("composes two calls to guard input, then guard the output of a subsequent call", async () => {
    let call = 0;
    active = mockFetch(() => {
      call += 1;
      // First check (input) allows; second check (output) blocks.
      return { json: call === 1 ? allowVerdict : blockVerdict };
    });

    const userInput = "what's my balance?";
    const safeInput = await runGuarded(() => userInput, { creds });
    expect(safeInput).toBe(userInput);

    const callModel = (input: string) => `here is your balance for "${input}": $42`;
    await expect(runGuarded(() => callModel(safeInput), { creds, onFailure: "raise" })).rejects.toThrow(
      GuardrailBlockedError,
    );

    expect(active.calls).toHaveLength(2);
    expect(active.calls[0].body).toEqual({ text: userInput });
    expect(active.calls[1].body).toEqual({ text: `here is your balance for "${userInput}": $42` });
  });
});
