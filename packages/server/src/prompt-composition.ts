/**
 * Prompt composability + chat placeholders — the two registry gaps that push real agent
 * prompts back out of the registry and into hand-rolled string concatenation.
 *
 * **Composability.** A prompt embeds another by reference:
 *
 *     @@@memoturnPrompt:name=safety-preamble|label=production@@@
 *
 * Without it, every prompt that shares a preamble either duplicates it (and drifts) or
 * assembles it in application code (where the registry can't see it). References resolve
 * server-side at RUNTIME, so updating the shared prompt updates every prompt that includes
 * it — which is the point, and also the reason cycles have to be impossible.
 *
 * **Placeholders.** A CHAT prompt reserves a slot that is filled at runtime with a LIST of
 * messages: chat history, retrieved few-shot examples. A `{{variable}}` can't express that —
 * it substitutes one string, not N messages with roles.
 *
 * Both are resolved here rather than in each SDK, so every language gets them at once and the
 * dependency graph is walked in exactly one place.
 */

/** Matches `@@@memoturnPrompt:name=X|label=Y@@@` or `…|version=3@@@`. */
const REF_PATTERN = /@@@memoturnPrompt:name=([^|@]+)\|(label|version)=([^|@]+)@@@/g;

/** How deep a chain of prompt-includes may go before we call it a mistake. */
export const MAX_COMPOSITION_DEPTH = 5;

export class PromptCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptCompositionError";
  }
}

export interface PromptRef {
  name: string;
  /** Exactly one of these is set. A label follows deploys; a version pins. */
  label?: string;
  version?: number;
}

/** A chat message as stored. `type: "placeholder"` marks a runtime-filled slot. */
export interface StoredMessage {
  role?: string;
  content?: unknown;
  type?: string;
  name?: string;
}

/** Every prompt reference inside a stored prompt body (text or chat), in order of appearance. */
export function extractPromptRefs(content: unknown): PromptRef[] {
  const refs: PromptRef[] = [];
  const scan = (text: string) => {
    for (const m of text.matchAll(REF_PATTERN)) {
      const [, name, kind, value] = m as unknown as [string, string, string, string];
      if (kind === "version") {
        const version = Number(value);
        if (Number.isInteger(version) && version > 0) refs.push({ name: name.trim(), version });
        continue;
      }
      refs.push({ name: name.trim(), label: value.trim() });
    }
  };
  if (typeof content === "string") scan(content);
  else if (Array.isArray(content)) {
    for (const msg of content as StoredMessage[]) {
      if (msg && typeof msg.content === "string") scan(msg.content);
    }
  }
  return refs;
}

/** The placeholder slot names a CHAT prompt declares, in order. */
export function extractPlaceholders(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const msg of content as StoredMessage[]) {
    if (msg?.type === "placeholder" && typeof msg.name === "string" && msg.name.trim()) names.push(msg.name.trim());
  }
  return names;
}

/**
 * Reject a prompt body that can't be resolved later. Called at SAVE time so a broken prompt is
 * a 400 the author sees, not a runtime failure in someone's request path.
 */
export function validatePromptBody(content: unknown, type: "TEXT" | "CHAT"): void {
  if (type === "CHAT") {
    if (!Array.isArray(content)) throw new PromptCompositionError("a CHAT prompt's content must be a message array");
    const seen = new Set<string>();
    for (const [i, raw] of (content as StoredMessage[]).entries()) {
      const msg = raw ?? {};
      if (msg.type === "placeholder") {
        const name = typeof msg.name === "string" ? msg.name.trim() : "";
        if (!name) throw new PromptCompositionError(`message ${i} is a placeholder with no name`);
        // Duplicate slots would make filling ambiguous — which list goes where?
        if (seen.has(name)) throw new PromptCompositionError(`duplicate placeholder "${name}"`);
        seen.add(name);
        continue;
      }
      if (typeof msg.role !== "string" || msg.role.trim() === "") {
        throw new PromptCompositionError(`message ${i} needs a role (or type: "placeholder")`);
      }
    }
  } else if (typeof content !== "string") {
    throw new PromptCompositionError("a TEXT prompt's content must be a string");
  }
  // A reference the author fat-fingered (`name=` empty) never matches the pattern and would
  // silently survive as literal text; catch the near-miss spelling instead.
  const suspicious = typeof content === "string" ? content : JSON.stringify(content ?? "");
  if (suspicious.includes("@@@memoturnPrompt") && extractPromptRefs(content).length === 0) {
    throw new PromptCompositionError(
      "malformed prompt reference — expected @@@memoturnPrompt:name=NAME|label=LABEL@@@ (or |version=N)",
    );
  }
}

/** Resolves one reference to the raw stored body of the referenced prompt version. */
export type RefResolver = (ref: PromptRef) => Promise<{ type: "TEXT" | "CHAT"; content: unknown } | null>;

/**
 * Expand every `@@@memoturnPrompt:…@@@` reference, depth-first, refusing cycles.
 *
 * A referenced prompt must be TEXT: its body is spliced into a string, and a message array has
 * no meaningful rendering inside one. That constraint is checked here rather than at save time
 * too, because the referenced prompt can change type after the referring one was written.
 */
export async function composePrompt(
  content: unknown,
  resolve: RefResolver,
  path: string[] = [],
  /**
   * Keys that count as a cycle if reached, without occupying depth. Used at SAVE time: the
   * version being written isn't live yet, so composing it would otherwise resolve the OLD body
   * of the same prompt and miss a cycle that appears the moment the save lands.
   */
  blocked: ReadonlySet<string> = new Set(),
): Promise<unknown> {
  if (path.length > MAX_COMPOSITION_DEPTH) {
    throw new PromptCompositionError(
      `prompt includes nested deeper than ${MAX_COMPOSITION_DEPTH}: ${[...path].join(" → ")}`,
    );
  }

  const expand = async (text: string): Promise<string> => {
    // Collect first, then replace: async work can't happen inside String.replace.
    const matches = [...text.matchAll(REF_PATTERN)];
    if (matches.length === 0) return text;
    let out = "";
    let cursor = 0;
    for (const m of matches) {
      const [whole, name, kind, value] = m as unknown as [string, string, string, string];
      const ref: PromptRef =
        kind === "version" ? { name: name.trim(), version: Number(value) } : { name: name.trim(), label: value.trim() };
      const key = `${ref.name}@${ref.label ?? `v${ref.version}`}`;
      if (path.includes(key) || blocked.has(key)) {
        throw new PromptCompositionError(`circular prompt reference: ${[...path, key].join(" → ")}`);
      }
      const target = await resolve(ref);
      if (!target) throw new PromptCompositionError(`referenced prompt not found: ${key}`);
      if (target.type !== "TEXT") {
        throw new PromptCompositionError(`referenced prompt "${key}" is a CHAT prompt and cannot be embedded in text`);
      }
      const nested = (await composePrompt(target.content, resolve, [...path, key], blocked)) as string;
      out += text.slice(cursor, m.index ?? 0) + nested;
      cursor = (m.index ?? 0) + whole.length;
    }
    return out + text.slice(cursor);
  };

  if (typeof content === "string") return expand(content);
  if (Array.isArray(content)) {
    return Promise.all(
      (content as StoredMessage[]).map(async (msg) =>
        msg && typeof msg.content === "string" ? { ...msg, content: await expand(msg.content) } : msg,
      ),
    );
  }
  return content;
}

/**
 * Fill placeholder slots with the caller's message lists and substitute `{{variables}}`.
 *
 * An unfilled placeholder is DROPPED rather than left in the output: a slot for chat history
 * on the first turn has nothing to put there, and shipping a literal `{"type":"placeholder"}`
 * to a provider would be a hard error at the worst moment. An unknown variable is left as
 * written, which is visible in the output instead of silently becoming an empty string.
 */
export function fillPrompt(
  content: unknown,
  opts: { variables?: Record<string, unknown>; placeholders?: Record<string, StoredMessage[]> } = {},
): unknown {
  const vars = opts.variables ?? {};
  const substitute = (text: string): string =>
    text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, name: string) => {
      if (!(name in vars)) return whole;
      const v = vars[name];
      return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
    });

  if (typeof content === "string") return substitute(content);
  if (!Array.isArray(content)) return content;

  const filled: StoredMessage[] = [];
  for (const msg of content as StoredMessage[]) {
    if (msg?.type === "placeholder") {
      const supplied = opts.placeholders?.[String(msg.name ?? "")];
      if (Array.isArray(supplied)) {
        for (const m of supplied) {
          filled.push(typeof m?.content === "string" ? { ...m, content: substitute(m.content) } : m);
        }
      }
      continue;
    }
    filled.push(typeof msg?.content === "string" ? { ...msg, content: substitute(msg.content) } : msg);
  }
  return filled;
}
