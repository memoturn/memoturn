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
