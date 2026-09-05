/**
 * Re-encrypt every secret at rest under the ACTIVE encryption key.
 *
 * Rotation procedure (docs/runbooks.md#rotate-encryption_key):
 *   1. ENCRYPTION_KEYS="<new>,<old>"  (new first = active; old stays readable)   → restart api + worker
 *   2. bun run rotate-secrets          → every row is rewritten under <new>
 *   3. ENCRYPTION_KEYS="<new>"         → restart; <old> can be destroyed
 *
 * Covers: ProviderConnection.encryptedKey, Automation.secret, AnalyticsSink.apiKey,
 * Webhook.secret (plaintext legacy rows are encrypted for the first time). Idempotent: rows
 * already under the active key are skipped. A row that cannot be decrypted with any key in
 * the ring is reported and left untouched — it needs the owner to re-enter the secret.
 *
 *   bun run rotate-secrets            # rewrite
 *   bun run rotate-secrets --dry-run  # count only
 */
import { prisma } from "@memoturn/db";
import { activeKeyId, decryptSecret, encryptSecret, isEncryptedSecret, needsReencrypt } from "@memoturn/llm";

const dryRun = process.argv.includes("--dry-run");

interface Target {
  name: string;
  list: () => Promise<{ id: string; value: string }[]>;
  write: (id: string, value: string) => Promise<unknown>;
}

const targets: Target[] = [
  {
    name: "ProviderConnection.encryptedKey",
    list: async () =>
      (await prisma.providerConnection.findMany({ select: { id: true, encryptedKey: true } })).map((r) => ({
        id: r.id,
        value: r.encryptedKey,
      })),
    write: (id, value) => prisma.providerConnection.update({ where: { id }, data: { encryptedKey: value } }),
  },
  {
    name: "Automation.secret",
    list: async () =>
      (await prisma.automation.findMany({ select: { id: true, secret: true } })).map((r) => ({
        id: r.id,
        value: r.secret,
      })),
    write: (id, value) => prisma.automation.update({ where: { id }, data: { secret: value } }),
  },
  {
    name: "AnalyticsSink.apiKey",
    list: async () =>
      (await prisma.analyticsSink.findMany({ select: { id: true, apiKey: true } })).map((r) => ({
        id: r.id,
        value: r.apiKey,
      })),
    write: (id, value) => prisma.analyticsSink.update({ where: { id }, data: { apiKey: value } }),
  },
  {
    name: "Webhook.secret",
    list: async () =>
      (await prisma.webhook.findMany({ select: { id: true, secret: true } })).map((r) => ({
        id: r.id,
        value: r.secret,
      })),
    write: (id, value) => prisma.webhook.update({ where: { id }, data: { secret: value } }),
  },
];

async function main() {
  console.log(`${dryRun ? "[dry-run] " : ""}active key ${activeKeyId()}`);
  let rewritten = 0;
  let skipped = 0;
  let unreadable = 0;
  for (const t of targets) {
    const rows = await t.list();
    for (const { id, value } of rows) {
      if (!value) {
        skipped++;
        continue;
      }
      let plaintext: string;
      if (!isEncryptedSecret(value)) {
        plaintext = value; // legacy plaintext (webhook secrets before encryption)
      } else if (needsReencrypt(value)) {
        try {
          plaintext = decryptSecret(value);
        } catch (err) {
          unreadable++;
          console.error(`  ✗ ${t.name} ${id}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      } else {
        skipped++;
        continue;
      }
      if (!dryRun) await t.write(id, encryptSecret(plaintext));
      rewritten++;
    }
    console.log(`  ${t.name}: ${rows.length} row(s)`);
  }
  console.log(`${dryRun ? "would rewrite" : "rewrote"} ${rewritten}, up to date ${skipped}, unreadable ${unreadable}`);
  if (unreadable > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("rotate-secrets failed:", err);
    process.exit(1);
  });
