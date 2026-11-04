import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthRouteAllowed, publicDemoLogin } from "./auth-lockdown.js";

afterEach(() => vi.unstubAllEnvs());

describe("isAuthRouteAllowed", () => {
  it("allows everything when lockdown is off", () => {
    vi.stubEnv("AUTH_LOCKDOWN", "");
    expect(isAuthRouteAllowed("POST", "/auth/organization/create")).toBe(true);
  });

  it("allows only the routes a read-only session needs", () => {
    vi.stubEnv("AUTH_LOCKDOWN", "true");
    expect(isAuthRouteAllowed("POST", "/auth/sign-in/email")).toBe(true);
    expect(isAuthRouteAllowed("GET", "/auth/get-session")).toBe(true);
    expect(isAuthRouteAllowed("POST", "/auth/sign-out")).toBe(true);
  });

  it.each([
    ["POST", "/auth/organization/create"],
    ["POST", "/auth/change-password"],
    ["POST", "/auth/revoke-sessions"],
    ["POST", "/auth/update-user"],
    ["POST", "/auth/sign-up/email"],
    ["POST", "/auth/two-factor/enable"],
    ["POST", "/auth/passkey/verify-registration"],
    ["POST", "/auth/sso/register"],
    ["POST", "/auth/oauth2/register"],
    ["GET", "/auth/admin/list-users"],
    ["GET", "/auth/some-future-plugin/endpoint"],
  ])("denies %s %s", (method, path) => {
    vi.stubEnv("AUTH_LOCKDOWN", "true");
    expect(isAuthRouteAllowed(method, path)).toBe(false);
  });

  it("matches on method and exact path", () => {
    vi.stubEnv("AUTH_LOCKDOWN", "true");
    expect(isAuthRouteAllowed("GET", "/auth/sign-in/email")).toBe(false);
    expect(isAuthRouteAllowed("POST", "/auth/sign-in/email/")).toBe(false);
    expect(isAuthRouteAllowed("POST", "/auth/sign-in/email/../../change-password")).toBe(false);
  });
});

describe("publicDemoLogin", () => {
  it("never serves credentials without lockdown", () => {
    vi.stubEnv("AUTH_LOCKDOWN", "");
    vi.stubEnv("PUBLIC_DEMO_EMAIL", "demo@example.com");
    vi.stubEnv("PUBLIC_DEMO_PASSWORD", "published-password");
    expect(publicDemoLogin()).toBeNull();
  });

  it("needs both values", () => {
    vi.stubEnv("AUTH_LOCKDOWN", "true");
    vi.stubEnv("PUBLIC_DEMO_EMAIL", "demo@example.com");
    vi.stubEnv("PUBLIC_DEMO_PASSWORD", "");
    expect(publicDemoLogin()).toBeNull();
  });

  it("serves them under lockdown", () => {
    vi.stubEnv("AUTH_LOCKDOWN", "true");
    vi.stubEnv("PUBLIC_DEMO_EMAIL", "demo@example.com");
    vi.stubEnv("PUBLIC_DEMO_PASSWORD", "published-password");
    expect(publicDemoLogin()).toEqual({ email: "demo@example.com", password: "published-password" });
  });
});
