/**
 * Emits a trace with a nested retrieval span and an LLM generation, then a score,
 * exercising the full pipeline: SDK → /v1/ingest → blob → queue → worker → Doris.
 *
 * Prereqs: `bun run infra:up`, `bun run db:migrate`, `bun run db:telemetry`, `bun run seed`,
 * and `pnpm dev` (web + worker) running. Then: `pnpm quickstart`.
 */
import { Memoturn } from "@memoturn/sdk";

async function main() {
  const memoturn = new Memoturn({
    baseUrl: process.env.MEMOTURN_BASE_URL ?? "http://localhost:3001",
    publicKey: process.env.MEMOTURN_PUBLIC_KEY ?? "pk-mt-dev",
    secretKey: process.env.MEMOTURN_SECRET_KEY ?? "sk-mt-dev",
  });

  const trace = memoturn.trace({
    name: "quickstart-rag",
    userId: "user-123",
    sessionId: "session-abc",
    input: { question: "What is memoturn?" },
    tags: ["example", "rag"],
  });

  const retrieval = trace.span({ name: "retrieve-docs", input: { query: "memoturn" } });
  await sleep(40);
  retrieval.end({ output: { docs: ["memoturn is an open-source AI engineering platform."] } });

  const generation = trace.generation({
    name: "answer",
    model: "claude-sonnet-4-6",
    modelParameters: { temperature: 0.2, maxTokens: 256 },
    input: [
      { role: "system", content: "Answer using the provided docs." },
      { role: "user", content: "What is memoturn?" },
    ],
  });
  await sleep(120);
  generation.end({
    output: { role: "assistant", content: "memoturn is an open-source AI engineering platform." },
    usage: { promptTokens: 320, completionTokens: 24 },
  });

  trace.update({ output: { answer: "memoturn is an open-source AI engineering platform." } });
  trace.score({ name: "user-feedback", value: 1, comment: "helpful" });

  await memoturn.shutdown();
  console.log(`emitted trace ${trace.id}`);
  console.log(`  open http://localhost:3000/traces/${trace.id}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error("quickstart failed:", err);
  process.exit(1);
});
