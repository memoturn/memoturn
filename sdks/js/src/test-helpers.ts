import { vi } from "vitest";

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Install a fake `global.fetch` that records every request and returns a canned
 * JSON response. Returns the capture array plus a restore fn. The SDK only ever
 * touches `res.ok`, `res.status`, `res.json()`, and `res.text()`, so the stub
 * implements just those.
 */
export function mockFetch(
  responder: (req: CapturedRequest) => { status?: number; json?: unknown; text?: string } = () => ({}),
) {
  const calls: CapturedRequest[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const req: CapturedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(req);
    const out = responder(req);
    const status = out.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => out.json ?? {},
      text: async () => out.text ?? "",
    } as Response;
  });
  const original = global.fetch;
  global.fetch = fn as unknown as typeof fetch;
  return {
    calls,
    fn,
    restore: () => {
      global.fetch = original;
    },
  };
}

/** Decode an `Authorization: Basic <base64>` header into `publicKey:secretKey`. */
export function decodeBasic(header: string | undefined): string {
  return Buffer.from(String(header).replace(/^Basic /, ""), "base64").toString("utf8");
}
