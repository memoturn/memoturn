import {
  addDatasetItems,
  addReviewItems,
  createDataset,
  createPromptVersion,
  createReviewQueue,
  getDatasetDetail,
  getPromptDetail,
  listDatasets,
  listPrompts,
  listReviewItems,
  listReviewQueues,
  resolvePrompt,
  submitReviewScore,
} from "@memoturn/server";

/**
 * MCP tool definitions exposing memoturn prompts, datasets, and review queues to
 * agent IDEs. Schemas are plain JSON Schema (no zod coupling) so the definition is
 * stable across MCP SDK versions; each handler is given the resolved projectId.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  handler: (projectId: string, args: Record<string, unknown>) => Promise<unknown>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const NOT_FOUND = (kind: string, name: string) => ({ error: `${kind} not found: ${name}` });

export const tools: ToolDef[] = [
  // ── Prompts ────────────────────────────────────────────────────────────────────
  {
    name: "list_prompts",
    description: "List all prompts in the project (name, folder, version count, deployment channels).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (projectId) => listPrompts(projectId),
  },
  {
    name: "get_prompt",
    description: "Get a prompt's full detail including every version, its content, and config.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Prompt name" } },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async (projectId, args) =>
      (await getPromptDetail(projectId, str(args.name))) ?? NOT_FOUND("prompt", str(args.name)),
  },
  {
    name: "resolve_prompt",
    description:
      "Resolve the deployed version of a prompt on a channel (default 'production'). Returns the compiled content + config — the same thing the SDK's getPrompt returns.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Prompt name" },
        channel: { type: "string", description: "Deployment channel, e.g. 'production' or 'latest'" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async (projectId, args) =>
      (await resolvePrompt(projectId, str(args.name), args.channel ? str(args.channel) : undefined)) ??
      NOT_FOUND("prompt", str(args.name)),
  },
  {
    name: "create_prompt_version",
    description:
      "Create a new version of a prompt (creating the prompt if it does not exist). Content is a string for text prompts or an array of chat messages for chat prompts.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Prompt name" },
        type: { type: "string", enum: ["text", "chat"], description: "Prompt type (default text)" },
        content: { description: "Prompt body: a string (text) or chat message array (chat)" },
        config: { type: "object", description: "Model/params config attached to the version" },
        folder: { type: "string", description: "Optional folder for organization" },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Deployment channel labels to point at this version",
        },
      },
      required: ["name", "content"],
      additionalProperties: false,
    },
    handler: (projectId, args) =>
      createPromptVersion(projectId, {
        name: str(args.name),
        type: args.type as never,
        content: args.content,
        config: args.config as Record<string, unknown> | undefined,
        folder: args.folder ? str(args.folder) : undefined,
        labels: Array.isArray(args.labels) ? (args.labels as string[]) : undefined,
      }),
  },

  // ── Datasets ───────────────────────────────────────────────────────────────────
  {
    name: "list_datasets",
    description: "List datasets in the project (name, description, item count, run count).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (projectId) => listDatasets(projectId),
  },
  {
    name: "get_dataset",
    description: "Get a dataset's items (input/expectedOutput/metadata) and its runs.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Dataset name" } },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async (projectId, args) =>
      (await getDatasetDetail(projectId, str(args.name))) ?? NOT_FOUND("dataset", str(args.name)),
  },
  {
    name: "create_dataset",
    description: "Create a dataset (idempotent on name).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Dataset name" },
        description: { type: "string", description: "Optional description" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: (projectId, args) =>
      createDataset(projectId, {
        name: str(args.name),
        description: args.description ? str(args.description) : undefined,
      }),
  },
  {
    name: "add_dataset_items",
    description:
      "Append items to a dataset. Each item has an input, an optional expectedOutput, and optional metadata.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Dataset name" },
        items: {
          type: "array",
          description: "Items to add",
          items: {
            type: "object",
            properties: {
              input: { description: "Item input (any JSON value)" },
              expectedOutput: { description: "Optional expected output (any JSON value)" },
              metadata: { type: "object", description: "Optional metadata" },
            },
            required: ["input"],
          },
        },
      },
      required: ["name", "items"],
      additionalProperties: false,
    },
    handler: async (projectId, args) => {
      const items = Array.isArray(args.items) ? (args.items as never[]) : [];
      return (await addDatasetItems(projectId, str(args.name), items)) ?? NOT_FOUND("dataset", str(args.name));
    },
  },

  // ── Review queues ────────────────────────────────────────────────────────────────
  {
    name: "list_review_queues",
    description: "List human-review queues (name, target score, pending/done counts).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (projectId) => listReviewQueues(projectId),
  },
  {
    name: "create_review_queue",
    description: "Create a review queue bound to a score name and data type.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Queue name" },
        scoreName: { type: "string", description: "Score collected by this queue" },
        dataType: { type: "string", enum: ["NUMERIC", "CATEGORICAL", "BOOLEAN"], description: "Score data type" },
        description: { type: "string", description: "Optional description" },
      },
      required: ["name", "scoreName"],
      additionalProperties: false,
    },
    handler: (projectId, args) =>
      createReviewQueue(projectId, {
        name: str(args.name),
        scoreName: str(args.scoreName),
        dataType: args.dataType as never,
        description: args.description ? str(args.description) : undefined,
      }),
  },
  {
    name: "add_review_items",
    description: "Enqueue traces into a review queue by trace id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Queue name" },
        traceIds: { type: "array", items: { type: "string" }, description: "Trace ids to enqueue" },
      },
      required: ["name", "traceIds"],
      additionalProperties: false,
    },
    handler: async (projectId, args) => {
      const ids = Array.isArray(args.traceIds) ? (args.traceIds as string[]) : [];
      return (await addReviewItems(projectId, str(args.name), ids)) ?? NOT_FOUND("review queue", str(args.name));
    },
  },
  {
    name: "list_review_items",
    description: "List items in a review queue (default status PENDING), including each item's trace input/output.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Queue name" },
        status: {
          type: "string",
          enum: ["PENDING", "DONE", "SKIPPED"],
          description: "Filter by status (default PENDING)",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async (projectId, args) =>
      (await listReviewItems(projectId, str(args.name), args.status ? str(args.status) : undefined)) ??
      NOT_FOUND("review queue", str(args.name)),
  },
  {
    name: "submit_review_score",
    description:
      "Submit a score for a review item. Use value for numeric/boolean scores (boolean: 1/0) or stringValue for categorical.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Queue name" },
        itemId: { type: "string", description: "Review item id" },
        value: { type: "number", description: "Numeric/boolean score value" },
        stringValue: { type: "string", description: "Categorical score value" },
        comment: { type: "string", description: "Optional reviewer comment" },
      },
      required: ["name", "itemId"],
      additionalProperties: false,
    },
    handler: async (projectId, args) =>
      (await submitReviewScore(projectId, str(args.name), str(args.itemId), {
        value: typeof args.value === "number" ? args.value : undefined,
        stringValue: args.stringValue ? str(args.stringValue) : undefined,
        comment: args.comment ? str(args.comment) : undefined,
      })) ?? NOT_FOUND("review item", str(args.itemId)),
  },
];
