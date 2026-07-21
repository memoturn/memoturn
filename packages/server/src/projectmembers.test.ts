import { describe, expect, it } from "vitest";
import { roleChangeDenial } from "./projectmembers.js";

describe("roleChangeDenial", () => {
  it("lets an owner assign any role, including owner", () => {
    expect(roleChangeDenial("OWNER", "member", "admin")).toBeNull();
    expect(roleChangeDenial("OWNER", "admin", "owner")).toBeNull();
    expect(roleChangeDenial("owner", "owner", "viewer")).toBeNull();
  });

  it("blocks an admin from granting owner (privilege escalation)", () => {
    expect(roleChangeDenial("ADMIN", "member", "owner")).toMatch(/above your own/);
  });

  it("blocks an admin from modifying an owner (the lockout attack)", () => {
    expect(roleChangeDenial("admin", "owner", "viewer")).toMatch(/outranks you/);
  });

  it("lets an admin manage members/viewers and promote up to admin", () => {
    expect(roleChangeDenial("admin", "member", "admin")).toBeNull();
    expect(roleChangeDenial("admin", "viewer", "member")).toBeNull();
    expect(roleChangeDenial("admin", "admin", "viewer")).toBeNull(); // equal-rank peer is allowed
  });
});
