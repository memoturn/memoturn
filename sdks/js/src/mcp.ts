import type { Memoturn, MemoturnTrace } from "./client.js";

type WrapOptions = { trace?: MemoturnTrace; traceName?: string };

/**
 * Auto-instrumentation for `@modelcontextprotocol/sdk` — the official TypeScript MCP SDK.
 * Two independent wrappers, duck-typed (no SDK import, so no hard dependency):
 *
 *   - `wrapMcpClient` — for apps that CALL tools via an MCP `Client`. Wraps `.callTool()`
 *     so every call is recorded as a TOOL observation (tool name + arguments as input,
 *     the result's `content` as output; `isError`/thrown errors mapped to level ERROR).
 *   - `wrapMcpServer` — for apps that IMPLEMENT an MCP server via `McpServer`. Wraps
 *     `.registerTool()` (and the legacy `.tool()` overload) so every registered handler is
 *     automatically recorded as a TOOL observation when invoked, without wrapping each
 *     handler by hand.
 *
 * Unlike the Python MCP SDK (which auto-traces via OpenTelemetry out of the box), the
 * TypeScript MCP SDK has no built-in tracing at all — `wrapMcpServer` in particular is
 * genuinely additive rather than a convenience shim around existing instrumentation.
 */

/**
 * Wraps an MCP `Client` instance — records each `.callTool()` call as a TOOL observation:
 * the tool name + `arguments` as input, the result's `content` array as output. MCP signals
 * tool-level failure via `result.isError` (not a thrown error) so that case marks the
 * observation ERROR without rethrowing; a transport-level throw (rejected `callTool` call)
 * marks it ERROR and rethrows.
 *
 *   const client = wrapMcpClient(new Client({ name: "my-app", version: "1.0.0" }), memoturn);
 *   await client.callTool({ name: "get-weather", arguments: { city: "SF" } });
 *
 * Pass `{ trace }` to nest calls under an existing trace; otherwise each call gets its own
 * trace (named `mcp.client`, override via `{ traceName }`).
 */
export function wrapMcpClient<T extends object>(client: T, memoturn: Memoturn, options: WrapOptions = {}): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop !== "callTool" || typeof original !== "function") return original;

      return async function callTool(params: any, ...rest: any[]) {
        const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "mcp.client" });
        const tool = trace.tool({ name: params?.name ?? "mcp.callTool", input: params?.arguments });
        try {
          const result = await (original as (...args: any[]) => Promise<any>).call(target, params, ...rest);
          const isError = result?.isError === true;
          tool.end({
            output: result?.content ?? result,
            ...(isError ? { level: "ERROR" as const, statusMessage: "tool returned isError" } : {}),
          });
          return result;
        } catch (err) {
          tool.end({ level: "ERROR", statusMessage: String(err) });
          throw err;
        }
      };
    },
  });
}

/**
 * Wraps an MCP `McpServer` instance — intercepts `.registerTool(name, config, cb)` (and the
 * deprecated `.tool(name, ..., cb)` overload, same trailing-callback shape) so every
 * registered handler is transparently wrapped: when the server invokes it, the call is
 * recorded as a TOOL observation (the tool `name`, the handler's first argument as input,
 * its return value's `content` as output). The handler's own return value — and any thrown
 * error — pass through unchanged, so this is safe to apply before handing the server to the
 * transport.
 *
 *   const server = wrapMcpServer(new McpServer({ name: "my-server", version: "1.0.0" }), memoturn);
 *   server.registerTool("get-weather", { description: "...", inputSchema: {...} }, async (args) => {
 *     return { content: [{ type: "text", text: `sunny in ${args.city}` }] };
 *   });
 *
 * Registration calls with no trailing callback function pass through untouched. Pass
 * `{ trace }` to nest every tool invocation under one shared trace; otherwise each
 * invocation gets its own trace (named `mcp.server`, override via `{ traceName }`).
 */
export function wrapMcpServer<T extends object>(server: T, memoturn: Memoturn, options: WrapOptions = {}): T {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if ((prop !== "registerTool" && prop !== "tool") || typeof original !== "function") return original;

      return function registerTool(name: string, ...rest: any[]) {
        const cb = rest[rest.length - 1];
        if (typeof cb !== "function") return (original as (...args: any[]) => any).apply(target, [name, ...rest]);

        const wrappedCb = async (...cbArgs: any[]) => {
          const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "mcp.server" });
          const toolSpan = trace.tool({ name, input: cbArgs[0] });
          try {
            const result = await cb(...cbArgs);
            toolSpan.end({ output: result?.content ?? result });
            return result;
          } catch (err) {
            toolSpan.end({ level: "ERROR", statusMessage: String(err) });
            throw err;
          }
        };

        return (original as (...args: any[]) => any).apply(target, [name, ...rest.slice(0, -1), wrappedCb]);
      };
    },
  });
}
