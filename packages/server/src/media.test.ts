import { describe, expect, it } from "vitest";
import { isDataUri, MEDIA_PREFIX, offloadMedia, type StoredMedia } from "./media.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const fakeStore = async (_projectId: string, uri: string): Promise<StoredMedia> => ({
  key: `media/p/${uri.length}.png`,
  mimeType: "image/png",
});

describe("isDataUri", () => {
  it("detects base64 data URIs only", () => {
    expect(isDataUri(PNG)).toBe(true);
    expect(isDataUri("hello")).toBe(false);
    expect(isDataUri("data:text/plain,notbase64")).toBe(false);
    expect(isDataUri(42)).toBe(false);
  });
});

describe("offloadMedia", () => {
  it("replaces a data URI with a memoturn-media:// marker", async () => {
    const out = await offloadMedia("p", PNG, fakeStore);
    expect(out).toBe(`${MEDIA_PREFIX}media/p/${PNG.length}.png`);
  });
  it("deep-walks objects + arrays and leaves non-media values untouched", async () => {
    const input = { prompt: "hi", image: PNG, list: ["x", PNG], n: 3, nested: { a: PNG } };
    const out = (await offloadMedia("p", input, fakeStore)) as Record<string, unknown>;
    expect(out.prompt).toBe("hi");
    expect(out.n).toBe(3);
    expect(out.image).toContain(MEDIA_PREFIX);
    expect((out.list as string[])[0]).toBe("x");
    expect((out.list as string[])[1]).toContain(MEDIA_PREFIX);
    expect((out.nested as Record<string, string>).a).toContain(MEDIA_PREFIX);
  });
  it("keeps the original string when the store declines", async () => {
    const out = await offloadMedia("p", PNG, async () => null);
    expect(out).toBe(PNG);
  });
});
