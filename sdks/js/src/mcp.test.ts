import { afterEach, describe, expect, it } from "vitest";
import { Memoturn } from "./client.js";
import { wrapMcpClient, wrapMcpServer } from "./mcp.js";
import { mockFetch } from "./test-helpers.js";
import type { IngestEnvelope } from "./types.js";

const creds = { baseUrl: "http://api.test", publicKey: "pk-mt-x", secretKey: "sk-mt-y", flushAt: 1000 };

let active: ReturnType<typeof mockFetch> | undefined;
afterEach(() => {
  active?.restore();
  active = undefined;
});

function batchFrom(m: ReturnType<typeof mockFetch>): IngestEnvelope[] {
  return (m.calls[0].body as { batch: IngestEnvelope[] }).batch;
}

/** Minimal stand-in for an MCP `Client` instance. */
function fakeMcpClient(callTool: (params: unknown) => Promise<unknown>, extra: Record<string, unknown> = {}) {
  return { callTool, ...extra };
}

describe("wrapMcpClient", () => {
  it("records a TOOL observation with the tool name and arguments as input", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const client = wrapMcpClient(
      fakeMcpClient(async () => ({ content: [{ type: "text", text: "sunny" }] })),
      memoturn,
    );

    await client.callTool({ name: "get-weather", arguments: { city: "SF" } });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect(create?.body).toMatchObject({ name: "get-weather", observationType: "TOOL", input: { city: "SF" } });
  });

  it("maps the result's content to output", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const content = [{ type: "text", text: "sunny" }];
    const client = wrapMcpClient(
      fakeMcpClient(async () => ({ content })),
      memoturn,
    );

    await client.callTool({ name: "get-weather" });
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect(update?.body.output).toEqual(content);
  });

  it("marks the observation ERROR (with a statusMessage) but does not throw when isError is true", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const client = wrapMcpClient(
      fakeMcpClient(async () => ({ content: [{ type: "text", text: "boom" }], isError: true })),
      memoturn,
    );

    const result = await client.callTool({ name: "flaky-tool" });
    expect(result).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect(update?.body.level).toBe("ERROR");
    expect(update?.body.statusMessage).toBeTruthy();
  });

  it("marks the observation ERROR and rethrows when callTool rejects", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const client = wrapMcpClient(
      fakeMcpClient(async () => {
        throw new Error("transport down");
      }),
      memoturn,
    );

    await expect(client.callTool({ name: "get-weather" })).rejects.toThrow("transport down");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("transport down");
  });

  it("nests under a provided trace, or creates a default mcp.client trace otherwise", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const trace = memoturn.trace({ name: "outer" });
    const client = wrapMcpClient(
      fakeMcpClient(async () => ({ content: [] })),
      memoturn,
      { trace },
    );

    await client.callTool({ name: "get-weather" });
    await memoturn.flush();

    const span = batchFrom(active).find((e) => e.type === "span-create");
    expect(span?.body.traceId).toBe(trace.id);
  });

  it("uses the default mcp.client trace name when no trace is provided", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const client = wrapMcpClient(
      fakeMcpClient(async () => ({ content: [] })),
      memoturn,
    );

    await client.callTool({ name: "get-weather" });
    await memoturn.flush();

    const traceCreate = batchFrom(active).find((e) => e.type === "trace-create");
    expect(traceCreate?.body.name).toBe("mcp.client");
  });

  it("leaves non-callTool properties/methods (listTools, close) untouched", () => {
    const memoturn = new Memoturn(creds);
    const listTools = () => Promise.resolve({ tools: [] });
    const close = () => Promise.resolve();
    const base = fakeMcpClient(async () => ({ content: [] }), { listTools, close });
    const client = wrapMcpClient(base, memoturn);
    expect(client.listTools).toBe(listTools);
    expect(client.close).toBe(close);
  });
});

/** Minimal stand-in for an MCP `McpServer` instance: `registerTool`/`tool` store the wrapped
 * callback and `invoke(name, ...args)` simulates the server dispatching a client call to it. */
function fakeMcpServer() {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    registerTool(name: string, _config: unknown, cb: (...args: any[]) => any) {
      handlers.set(name, cb);
    },
    tool(name: string, _description: string, cb: (...args: any[]) => any) {
      handlers.set(name, cb);
    },
    async invoke(name: string, ...args: any[]) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`no handler registered for ${name}`);
      return handler(...args);
    },
  };
}

describe("wrapMcpServer", () => {
  it("records a TOOL observation with the tool name and the first callback argument as input", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const server = wrapMcpServer(fakeMcpServer(), memoturn);

    server.registerTool("get-weather", { description: "..." }, async (args: { city: string }) => ({
      content: [{ type: "text", text: `sunny in ${args.city}` }],
    }));
    await server.invoke("get-weather", { city: "SF" });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect(create?.body).toMatchObject({ name: "get-weather", observationType: "TOOL", input: { city: "SF" } });
  });

  it("returns the handler's own return value unchanged through the wrapper and back out of registerTool", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const server = wrapMcpServer(fakeMcpServer(), memoturn);
    const payload = { content: [{ type: "text", text: "sunny" }] };

    server.registerTool("get-weather", {}, async () => payload);
    const result = await server.invoke("get-weather", { city: "SF" });

    expect(result).toEqual(payload);
    await memoturn.flush();
  });

  it("marks the observation ERROR and still propagates the error when the handler throws", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const server = wrapMcpServer(fakeMcpServer(), memoturn);

    server.registerTool("get-weather", {}, async () => {
      throw new Error("upstream unavailable");
    });
    await expect(server.invoke("get-weather", { city: "SF" })).rejects.toThrow("upstream unavailable");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("upstream unavailable");
  });

  it("wraps the legacy .tool(name, ..., cb) overload the same way as registerTool", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const server = wrapMcpServer(fakeMcpServer(), memoturn);

    server.tool("legacy-tool", "a legacy tool", async (args: { x: number }) => ({ content: args.x }));
    await server.invoke("legacy-tool", { x: 42 });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect(create?.body).toMatchObject({ name: "legacy-tool", observationType: "TOOL", input: { x: 42 } });
  });

  it("passes through to the original unwrapped when registerTool is called with no callback", () => {
    const memoturn = new Memoturn(creds);
    const base = fakeMcpServer();
    let calledWith: unknown;
    base.registerTool = ((name: string, config: unknown) => {
      calledWith = { name, config };
    }) as any;
    const server = wrapMcpServer(base, memoturn);

    expect(() => server.registerTool("no-op-tool", { description: "no handler yet" })).not.toThrow();
    expect(calledWith).toEqual({ name: "no-op-tool", config: { description: "no handler yet" } });
  });

  it("leaves non-registerTool/tool properties untouched", () => {
    const memoturn = new Memoturn(creds);
    const base = fakeMcpServer();
    const connect = () => Promise.resolve();
    (base as any).connect = connect;
    const server = wrapMcpServer(base, memoturn);
    expect((server as any).connect).toBe(connect);
  });
});
