/**
 * Seeds a default workspace, project, and a deterministic dev API key
 * (pk-mt-dev / sk-mt-dev) so the SDK + examples work out of the box. Idempotent.
 *
 * Run with: pnpm seed
 */
import { prisma, hashSecret } from "@memoturn/db";
import { auth } from "@memoturn/server";

const DEV_PUBLIC_KEY = "pk-mt-dev";
const DEV_SECRET_KEY = "sk-mt-dev";
const DEV_EMAIL = "admin@memoturn.dev";
const DEV_PASSWORD = "memoturn-dev-123";

async function main() {
  const workspace = await prisma.workspace.upsert({
    where: { slug: "default" },
    update: {},
    create: { name: "Default Workspace", slug: "default" },
  });

  const project = await prisma.project.upsert({
    where: { workspaceId_slug: { workspaceId: workspace.id, slug: "default" } },
    update: {},
    create: { name: "Default Project", slug: "default", workspaceId: workspace.id },
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

  // Dashboard login user (via Better Auth) + membership to the default workspace.
  let user = await prisma.user.findUnique({ where: { email: DEV_EMAIL } });
  if (!user) {
    await auth.api.signUpEmail({ body: { email: DEV_EMAIL, password: DEV_PASSWORD, name: "Admin" } });
    user = await prisma.user.findUnique({ where: { email: DEV_EMAIL } });
  }
  if (user) {
    await prisma.membership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
      update: {},
      create: { userId: user.id, workspaceId: workspace.id, role: "OWNER" },
    });
  }

  console.log("Seeded:");
  console.log(`  login     : ${DEV_EMAIL} / ${DEV_PASSWORD}`);
  console.log(`  workspace : ${workspace.name} (${workspace.id})`);
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
