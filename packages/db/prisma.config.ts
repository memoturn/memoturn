import { defineConfig } from "prisma/config";

/**
 * Prisma 7 config. The connection URL lives here (and on the runtime adapter) rather
 * than in schema.prisma. CLI commands (migrate/generate) read DATABASE_URL from the
 * environment — run them with the root .env loaded (the package scripts handle this).
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL },
});
