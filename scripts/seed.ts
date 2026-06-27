/**
 * Seeds a default organization, project, and a deterministic dev API key
 * (pk-mt-dev / sk-mt-dev) so the SDK + examples work out of the box. Idempotent.
 *
 * Run with: pnpm seed
 *
 * SAFETY: refuses to run when NODE_ENV=production unless ALLOW_SEED=1 — the dev
 * credentials below are public knowledge, so seeding them into a production database
 * would create a trivially-compromised admin + API key. When explicitly allowed in
 * production it generates RANDOM credentials (overridable via SEED_ADMIN_EMAIL /
 * SEED_ADMIN_PASSWORD) and prints them once.
 */
import { randomBytes } from "node:crypto";
import { hashSecret, prisma } from "@memoturn/db";
import { auth } from "@memoturn/server";

const isProd = process.env.NODE_ENV === "production";
if (isProd && process.env.ALLOW_SEED !== "1") {
  console.error(
    "Refusing to seed in production. The default credentials are public. " +
      "Set ALLOW_SEED=1 to bootstrap with randomly generated credentials.",
  );
  process.exit(1);
}

const rand = () => randomBytes(18).toString("base64url");

// Dev defaults are used in non-production; production (ALLOW_SEED=1) gets random secrets.
const DEV_PUBLIC_KEY = isProd ? `pk-mt-${rand()}` : "pk-mt-dev";
const DEV_SECRET_KEY = isProd ? `sk-mt-${rand()}` : "sk-mt-dev";
const DEV_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@memoturn.dev";
const DEV_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? (isProd ? rand() : "memoturn-dev-123");

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: "default" },
    update: {},
    create: { name: "Default Org", slug: "default" },
  });

  const project = await prisma.project.upsert({
    where: { organizationId_slug: { organizationId: org.id, slug: "default" } },
    update: {},
    create: { name: "Default Project", slug: "default", organizationId: org.id },
  });

  await prisma.apiKey.upsert({
    where: { publicKey: DEV_PUBLIC_KEY },
    update: { projectId: project.id, secretHash: hashSecret(DEV_SECRET_KEY) },
    create: {
      projectId: project.id,
      publicKey: DEV_PUBLIC_KEY,
      secretHash: hashSecret(DEV_SECRET_KEY),
      secretHint: DEV_SECRET_KEY.slice(-4),
      name: "dev key",
    },
  });

  // Sample prompt (chat) deployed to the "production" channel as v1.
  const prompt = await prisma.prompt.upsert({
    where: { projectId_name: { projectId: project.id, name: "support-reply" } },
    update: {},
    create: { projectId: project.id, name: "support-reply", folder: "support" },
  });
  const existingV1 = await prisma.promptVersion.findUnique({
    where: { promptId_version: { promptId: prompt.id, version: 1 } },
  });
  if (!existingV1) {
    await prisma.promptVersion.create({
      data: {
        promptId: prompt.id,
        version: 1,
        type: "CHAT",
        content: [
          { role: "system", content: "You are a concise support agent for {{product}}." },
          { role: "user", content: "{{question}}" },
        ],
        config: { model: "claude-sonnet-4-6", temperature: 0.2 },
      },
    });
    for (const label of ["latest", "production"]) {
      await prisma.promptChannel.upsert({
        where: { promptId_label: { promptId: prompt.id, label } },
        update: { version: 1 },
        create: { promptId: prompt.id, label, version: 1 },
      });
    }
  }

  // Dashboard login user (via Better Auth) + owner membership of the default org.
  let user = await prisma.user.findUnique({ where: { email: DEV_EMAIL } });
  if (!user) {
    await auth.api.signUpEmail({ body: { email: DEV_EMAIL, password: DEV_PASSWORD, name: "Admin" } });
    user = await prisma.user.findUnique({ where: { email: DEV_EMAIL } });
  }
  if (user) {
    await prisma.member.upsert({
      where: { organizationId_userId: { userId: user.id, organizationId: org.id } },
      update: {},
      create: { userId: user.id, organizationId: org.id, role: "owner" },
    });
  }

  console.log("Seeded:");
  console.log(`  login     : ${DEV_EMAIL} / ${DEV_PASSWORD}`);
  console.log(`  org       : ${org.name} (${org.id})`);
  console.log(`  project   : ${project.name} (${project.id})`);
  console.log(`  publicKey : ${DEV_PUBLIC_KEY}`);
  console.log(`  secretKey : ${DEV_SECRET_KEY}`);
  console.log(`  prompt    : support-reply (CHAT) @ production=v1`);
  console.log("\nSet these in .env (already the defaults in .env.example).");

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Seed failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
