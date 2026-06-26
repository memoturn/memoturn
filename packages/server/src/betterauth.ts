import { sso } from "@better-auth/sso";
import { prisma } from "@memoturn/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAccessControl } from "better-auth/plugins/access";
import { organization } from "better-auth/plugins/organization";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";

/**
 * Better Auth instance — email/password auth + the organization plugin (tenancy) + SSO
 * (external OIDC/SAML identity providers) on the Prisma (Postgres) adapter. Lives in
 * @memoturn/server so the API (handler + session checks) and the seed script
 * (server-side signup) share one configured instance. Mounted at /auth/* by the API;
 * the console reaches it via its dev proxy (/api/auth/* -> /auth/*).
 */

// Four-role access model: owner/admin/member inherit the org plugin defaults; viewer is
// a read-only role (no org permissions) enforced as read-only at the API layer too.
const ac = createAccessControl(defaultStatements);
export const orgRoles = {
  owner: ownerAc,
  admin: adminAc,
  member: memberAc,
  viewer: ac.newRole({}),
};

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true },
  basePath: "/auth",
  baseURL: process.env.AUTH_BASE_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`,
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-change-me",
  trustedOrigins: (process.env.AUTH_TRUSTED_ORIGINS ?? "http://localhost:3000").split(","),
  advanced: { cookiePrefix: "memoturn" },
  plugins: [
    // Let customers sign into memoturn with their own IdP (OIDC/SAML), mapped by email domain.
    sso(),
    organization({
      ac,
      roles: orgRoles,
      creatorRole: "owner",
      organizationHooks: {
        // Every new org gets a default project so it's immediately usable.
        afterCreateOrganization: async ({ organization: org }) => {
          await prisma.project.upsert({
            where: { organizationId_slug: { organizationId: org.id, slug: "default" } },
            update: {},
            create: { organizationId: org.id, name: "Default Project", slug: "default" },
          });
        },
      },
    }),
  ],
  databaseHooks: {
    session: {
      create: {
        // Default a new session's active organization to the user's first membership,
        // so project resolution works without the client calling setActiveOrganization.
        before: async (session) => {
          const m = await prisma.member.findFirst({
            where: { userId: session.userId },
            orderBy: { createdAt: "asc" },
          });
          return { data: { ...session, activeOrganizationId: m?.organizationId ?? null } };
        },
      },
    },
  },
});

export type AuthSession = typeof auth.$Infer.Session;
