import { authenticateKeys } from "@memoturn/server";
import { prisma } from "@memoturn/db";
const k = await prisma.apiKey.findUnique({ where: { publicKey: "pk-mt-dev" } });
console.log("apikey row:", k ? { projectId: k.projectId, hint: k.secretHint } : null);
const r = await authenticateKeys("pk-mt-dev", "sk-mt-dev");
console.log("authenticateKeys result:", r);
await prisma.$disconnect();
