import { prisma } from "@memoturn/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

/**
 * Better Auth instance — email/password auth on the Prisma (Postgres) adapter. Lives
 * in @memoturn/server so both the API (handler + session checks) and the seed script
 * (server-side signup) share one configured instance. Mounted at /auth/* by the API;
 * the console reaches it via its dev proxy (/api/auth/* -> /auth/*).
 */
export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true },
  basePath: "/auth",
  baseURL: process.env.AUTH_BASE_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`,
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-change-me",
  trustedOrigins: (process.env.AUTH_TRUSTED_ORIGINS ?? "http://localhost:3000").split(","),
});

export type AuthSession = typeof auth.$Infer.Session;
