import { describe, expect, it } from "vitest";
import { applyMasking, compileMaskers } from "./masking.js";

const policy = (over: Partial<Parameters<typeof compileMaskers>[0]> = {}) => ({
  enabled: true,
  builtins: [],
  customPatterns: [],
  redactWith: "[REDACTED]",
  ...over,
});

describe("compileMaskers", () => {
  it("compiles built-ins and drops invalid custom regexes", () => {
    const m = compileMaskers(
      policy({ builtins: ["email", "bogus"], customPatterns: ["[unterminated", "secret-\\d+"] }),
    );
    // email built-in (bogus dropped) + the one valid custom pattern
    expect(m.regexes).toHaveLength(2);
  });
});

describe("applyMasking", () => {
  it("redacts emails in strings", () => {
    const m = compileMaskers(policy({ builtins: ["email"] }));
    expect(applyMasking("contact a.b+x@example.co.uk now", m)).toBe("contact [REDACTED] now");
  });
  it("deep-walks objects + arrays, leaving non-matches intact", () => {
    const m = compileMaskers(policy({ builtins: ["email", "ssn"] }));
    const out = applyMasking(
      { user: "joe", email: "joe@x.com", ssn: "123-45-6789", list: ["ok", "x@y.io"], n: 5 },
      m,
    ) as Record<string, unknown>;
    expect(out.user).toBe("joe");
    expect(out.email).toBe("[REDACTED]");
    expect(out.ssn).toBe("[REDACTED]");
    expect((out.list as string[])[0]).toBe("ok");
    expect((out.list as string[])[1]).toBe("[REDACTED]");
    expect(out.n).toBe(5);
  });
  it("applies custom patterns and a custom replacement", () => {
    const m = compileMaskers(policy({ customPatterns: ["sk-[a-z0-9]+"], redactWith: "***" }));
    expect(applyMasking("key sk-abc123 end", m)).toBe("key *** end");
  });
  it("is a no-op when no patterns are configured", () => {
    const m = compileMaskers(policy());
    const input = { email: "a@b.com" };
    expect(applyMasking(input, m)).toBe(input);
  });
});
