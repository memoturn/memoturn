import { beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueOrThrow = vi.fn();
const count = vi.fn();
const del = vi.fn().mockResolvedValue({});
const purgeProjectData = vi.fn().mockResolvedValue({ telemetry: true, blobObjects: 0, blobErrors: [] });

vi.mock("@memoturn/db", () => ({
  prisma: { project: { findUniqueOrThrow, count, delete: del, findMany: vi.fn(), create: vi.fn(), update: vi.fn() } },
}));
vi.mock("./lifecycle.js", () => ({ purgeProjectData }));

const { deleteProject } = await import("./projects.js");

describe("deleteProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueOrThrow.mockResolvedValue({ name: "Proj", organizationId: "org1" });
  });

  it("refuses to delete the last project in an organization", async () => {
    count.mockResolvedValue(1);
    await expect(deleteProject("p1")).rejects.toThrow(/last project/);
    expect(del).not.toHaveBeenCalled();
    expect(purgeProjectData).not.toHaveBeenCalled();
  });

  it("deletes the Postgres row and purges telemetry + blob (the RetentionPolicy cascades away with it)", async () => {
    count.mockResolvedValue(2);
    const r = await deleteProject("p1");
    expect(del).toHaveBeenCalledWith({ where: { id: "p1" } });
    expect(purgeProjectData).toHaveBeenCalledWith("p1");
    expect(r).toEqual({ name: "Proj", organizationId: "org1" });
  });
});
