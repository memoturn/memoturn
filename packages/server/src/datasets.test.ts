import { describe, expect, it } from "vitest";
import { datasetItemsToJsonl } from "./datasets.js";

const parse = (content: string) =>
  content
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("datasetItemsToJsonl (oai-chat — OpenAI fine-tuning format)", () => {
  it("emits a chat line: normalized input messages + expectedOutput as the final assistant turn", () => {
    const { content, count, skipped } = datasetItemsToJsonl(
      [
        {
          input: [
            { role: "system", content: "be helpful" },
            { role: "user", content: "hi" },
          ],
          expectedOutput: "hello!",
          metadata: {},
        },
      ],
      "oai-chat",
    );
    expect(count).toBe(1);
    expect(skipped).toBe(0);
    const [line] = parse(content);
    expect(line.messages).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
    ]);
  });

  it("accepts {messages} objects and plain-text inputs (same normalization as experiments)", () => {
    const { content } = datasetItemsToJsonl(
      [
        { input: { messages: [{ role: "user", content: "from wrapper" }] }, expectedOutput: "a", metadata: {} },
        { input: "plain question", expectedOutput: "b", metadata: {} },
      ],
      "oai-chat",
    );
    const [wrapped, plain] = parse(content);
    expect(wrapped.messages[0]).toEqual({ role: "user", content: "from wrapper" });
    expect(plain.messages[0]).toEqual({ role: "user", content: "plain question" });
    expect(plain.messages[1]).toEqual({ role: "assistant", content: "b" });
  });

  it("stringifies non-string expectedOutput for the assistant turn", () => {
    const { content } = datasetItemsToJsonl([{ input: "q", expectedOutput: { answer: 42 }, metadata: {} }], "oai-chat");
    const [line] = parse(content);
    expect(line.messages.at(-1)).toEqual({ role: "assistant", content: '{"answer":42}' });
  });

  it("skips items without an expectedOutput and reports the count", () => {
    const { count, skipped, content } = datasetItemsToJsonl(
      [
        { input: "has target", expectedOutput: "t", metadata: {} },
        { input: "no target", expectedOutput: null, metadata: {} },
        { input: "also none", expectedOutput: undefined, metadata: {} },
      ],
      "oai-chat",
    );
    expect(count).toBe(1);
    expect(skipped).toBe(2);
    expect(parse(content)).toHaveLength(1);
  });

  it("returns empty content for an empty dataset", () => {
    expect(datasetItemsToJsonl([], "oai-chat")).toEqual({ content: "", count: 0, skipped: 0 });
  });
});

describe("datasetItemsToJsonl (items — backup dump)", () => {
  it("emits every item verbatim with null/{} defaults, none skipped", () => {
    const { content, count, skipped } = datasetItemsToJsonl(
      [
        { input: { q: 1 }, expectedOutput: { a: 2 }, metadata: { traceId: "t1" } },
        { input: "bare", expectedOutput: null, metadata: null },
      ],
      "items",
    );
    expect(count).toBe(2);
    expect(skipped).toBe(0);
    const [a, b] = parse(content);
    expect(a).toEqual({ input: { q: 1 }, expectedOutput: { a: 2 }, metadata: { traceId: "t1" } });
    expect(b).toEqual({ input: "bare", expectedOutput: null, metadata: {} });
  });
});

describe("datasetItemsToJsonl (anthropic-messages — Anthropic fine-tuning format)", () => {
  it("hoists the system prompt into a top-level field, unlike the OpenAI format", () => {
    const items = [
      {
        input: [
          { role: "system", content: "be helpful" },
          { role: "user", content: "hi" },
        ],
        expectedOutput: "hello!",
        metadata: {},
      },
    ];
    const [anthropic] = parse(datasetItemsToJsonl(items, "anthropic-messages").content);
    const [openai] = parse(datasetItemsToJsonl(items, "oai-chat").content);

    // The Messages API keeps system OUT of the message list; Chat Completions keeps it in.
    expect(anthropic.system).toBe("be helpful");
    expect(anthropic.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
    ]);
    expect(openai.system).toBeUndefined();
    expect(openai.messages[0]).toEqual({ role: "system", content: "be helpful" });
  });

  it("omits `system` entirely when the item has no system prompt", () => {
    const [line] = parse(
      datasetItemsToJsonl([{ input: "plain question", expectedOutput: "a", metadata: {} }], "anthropic-messages")
        .content,
    );
    expect("system" in line).toBe(false);
    expect(line.messages).toEqual([
      { role: "user", content: "plain question" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("joins several system messages rather than dropping all but one", () => {
    const [line] = parse(
      datasetItemsToJsonl(
        [
          {
            input: [
              { role: "system", content: "rule one" },
              { role: "system", content: "rule two" },
              { role: "user", content: "go" },
            ],
            expectedOutput: "ok",
            metadata: {},
          },
        ],
        "anthropic-messages",
      ).content,
    );
    expect(line.system).toBe("rule one\n\nrule two");
  });

  it("skips items with no expectedOutput, like the OpenAI format", () => {
    const { count, skipped } = datasetItemsToJsonl(
      [
        { input: "a", expectedOutput: "target", metadata: {} },
        { input: "b", expectedOutput: null, metadata: {} },
      ],
      "anthropic-messages",
    );
    expect({ count, skipped }).toEqual({ count: 1, skipped: 1 });
  });

  it("skips a system-only item rather than emitting a line with no conversation", () => {
    const { content, count, skipped } = datasetItemsToJsonl(
      [{ input: [{ role: "system", content: "only a system prompt" }], expectedOutput: "x", metadata: {} }],
      "anthropic-messages",
    );
    expect({ count, skipped }).toEqual({ count: 0, skipped: 1 });
    expect(content).toBe("");
  });

  it("preserves multi-turn conversations", () => {
    const [line] = parse(
      datasetItemsToJsonl(
        [
          {
            input: [
              { role: "user", content: "first" },
              { role: "assistant", content: "reply" },
              { role: "user", content: "second" },
            ],
            expectedOutput: "final",
            metadata: {},
          },
        ],
        "anthropic-messages",
      ).content,
    );
    expect(line.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});
