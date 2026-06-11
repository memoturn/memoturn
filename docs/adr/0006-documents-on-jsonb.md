# ADR-0006: Document-first API on SQLite JSONB; no Mongo wire protocol in v1

**Status:** accepted · 2026-06

**Decision:** the primary developer surface is a Mongo-style document API — collections, JSON
filters (`$gt/$in/$and/...`), update operators (`$set/$inc/...`) — implemented as lazily-created
reserved tables (`__memoturn_docs_{collection}`) holding JSONB, compiled to SQL over
`jsonb_extract`, with secondary indexes as generated columns on JSON paths. SQL remains exposed as
the power-user escape hatch. We do **not** implement the MongoDB wire protocol in v1.

**Why:** agents natively produce/consume JSON and their schemas evolve constantly — documents are
the right default surface. Layering on JSONB keeps the entire engine design (replication,
branching, tiering, vectors) untouched: a document write is just a SQL write.

**Why not a Mongo clone:** wire-protocol compatibility is a large, ongoing compatibility burden
(the FerretDB lesson), ties us to another vendor's API quirks, and positions us in a commoditized
market. Our differentiation is the agent-memory platform, not Mongo compatibility. Revisit only on
concrete customer pull.

**Out of scope v1:** aggregation pipelines (use SQL), multi-document unique indexes beyond `_id`.
