-- Backfill: dataset versioning v1.
-- Give every existing dataset an immutable v1 snapshot of its current working set,
-- and pin existing runs to that v1 so historical comparisons stay reproducible.
-- Idempotent: only creates a v1 for datasets that don't have one yet.
INSERT INTO "DatasetVersion" ("id", "datasetId", "version", "label", "description", "itemCount", "createdAt")
SELECT gen_random_uuid()::text, d."id", 1, 'v1', 'Backfilled initial version',
       (SELECT count(*) FROM "DatasetItem" di WHERE di."datasetId" = d."id"),
       CURRENT_TIMESTAMP
FROM "Dataset" d
WHERE NOT EXISTS (
  SELECT 1 FROM "DatasetVersion" dv WHERE dv."datasetId" = d."id" AND dv."version" = 1
);

INSERT INTO "DatasetVersionItem" ("id", "versionId", "datasetItemId", "input", "expectedOutput", "metadata")
SELECT gen_random_uuid()::text, dv."id", di."id", di."input", di."expectedOutput", di."metadata"
FROM "DatasetItem" di
JOIN "DatasetVersion" dv ON dv."datasetId" = di."datasetId" AND dv."version" = 1
WHERE NOT EXISTS (
  SELECT 1 FROM "DatasetVersionItem" dvi
  WHERE dvi."versionId" = dv."id" AND dvi."datasetItemId" = di."id"
);

UPDATE "Dataset" SET "currentVersion" = 1 WHERE "currentVersion" = 0;

UPDATE "DatasetRun" r
SET "versionId" = dv."id"
FROM "DatasetVersion" dv
WHERE dv."datasetId" = r."datasetId" AND dv."version" = 1 AND r."versionId" IS NULL;
