import { afterEach, describe, expect, it } from "vitest";
import { addDatasetItems, createDataset, getDataset } from "./dataset.js";
import { decodeBasic, mockFetch } from "./test-helpers.js";

// dataset.ts defaults baseUrl to :3001 (the API), unlike the tracing client (:3000).
const creds = { baseUrl: "http://api.test", publicKey: "pk-mt-x", secretKey: "sk-mt-y" };

let active: ReturnType<typeof mockFetch> | undefined;
afterEach(() => {
  active?.restore();
  active = undefined;
});

describe("createDataset", () => {
  it("POSTs name + description to /v1/datasets with Basic auth", async () => {
    active = mockFetch(() => ({ json: {} }));
    await createDataset(creds, "qa", "smoke set");
    const req = active.calls[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://api.test/v1/datasets");
    expect(req.body).toEqual({ name: "qa", description: "smoke set" });
    expect(req.headers["content-type"]).toBe("application/json");
    expect(decodeBasic(req.headers.authorization)).toBe("pk-mt-x:sk-mt-y");
  });
});

describe("addDatasetItems", () => {
  it("POSTs items to /v1/datasets/:name/items and returns the result", async () => {
    active = mockFetch(() => ({ json: { added: 2, itemIds: ["a", "b"] } }));
    const out = await addDatasetItems(creds, "qa set", [{ input: "x" }, { input: "y", expectedOutput: "z" }]);
    expect(active.calls[0].url).toBe("http://api.test/v1/datasets/qa%20set/items");
    expect(active.calls[0].body).toEqual({ items: [{ input: "x" }, { input: "y", expectedOutput: "z" }] });
    expect(out).toEqual({ added: 2, itemIds: ["a", "b"] });
  });
});

describe("getDataset", () => {
  it("GETs the dataset and exposes a recordRun() that POSTs to /runs", async () => {
    active = mockFetch((req) =>
      req.method === "GET"
        ? { json: { name: "qa", description: "d", items: [{ id: "i1", input: 1, expectedOutput: 2, metadata: null }] } }
        : { json: { run: "r1", linked: 1 } },
    );

    const ds = await getDataset(creds, "qa");
    expect(ds.name).toBe("qa");
    expect(ds.items).toHaveLength(1);

    const result = await ds.recordRun("baseline", [{ datasetItemId: "i1", traceId: "t1" }]);
    expect(result).toEqual({ run: "r1", linked: 1 });
    const post = active.calls[1];
    expect(post.method).toBe("POST");
    expect(post.url).toBe("http://api.test/v1/datasets/qa/runs");
    expect(post.body).toEqual({ runName: "baseline", links: [{ datasetItemId: "i1", traceId: "t1" }] });
  });
});

describe("error handling", () => {
  it("throws method + path + status on failure", async () => {
    active = mockFetch(() => ({ status: 403, text: "read only" }));
    await expect(createDataset(creds, "qa")).rejects.toThrow(/POST \/v1\/datasets failed: 403 read only/);
  });
});
