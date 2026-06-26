---
name: change-prisma-schema
description: How to change the Prisma/Postgres schema in memoturn — add a model/field/relation, run the migration with correct env loading, regenerate the client, and the Project reverse-relation convention. Use when editing packages/db/prisma/schema.prisma.
---

# Change the Prisma schema

memoturn uses **Prisma 7 driver-adapter style**: the connection URL lives in code + `prisma.config.ts`, not the schema. The generated client must be regenerated after any change or the rest of the monorepo gets stale-client type errors.

## Steps

1. Edit `packages/db/prisma/schema.prisma`.
2. **Reverse relation on `Project`** — for any new project-scoped model, add the reverse-relation field on the `Project` model (e.g. `widgets Widget[]`). Look at `Project` for the pattern; most domain models are listed there. Forgetting it cascades type errors.
3. Create the migration with env loaded (the `start`-style flow doesn't auto-load `.env`):
   ```bash
   cd packages/db && set -a; . ../../.env; set +a; bunx prisma migrate dev --name <change>
   ```
   This also regenerates the client. If you only edited the schema, run `bun run db:generate`.
4. From the repo root: `bun run typecheck`. Stale-client errors ("Property X does not exist") mean regenerate.

## Gotchas

- Migrations under `packages/db/prisma/migrations/` are **immutable** — never hand-edit (a hook blocks it). Change the schema and create a new migration instead.
- Dev Postgres is host port **5433** (not 5432) — already in `.env`; don't change it.
- High-volume, analytically-queried telemetry belongs in **ClickHouse**, not Postgres — if the new model is telemetry, reconsider.

For the full workflow with migration + typecheck, delegate to the **prisma-migrator** agent.
