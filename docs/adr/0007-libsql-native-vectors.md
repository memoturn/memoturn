# ADR-0007: libSQL native vectors (F32_BLOB + DiskANN), not sqlite-vec

**Status:** accepted · 2026-06

**Decision:** vector search uses libSQL's native vector type (`F32_BLOB`) and DiskANN-based ANN
index. Vectors are ordinary indexed columns inside the database file, so they **replicate, fork,
and rewind for free** through the segment/manifest machinery — the deciding property. Target
scale (10³–10⁵ embeddings per agent DB) is comfortably in range.

**Rejected:** *sqlite-vec* — still pre-v1 with documented breaking changes to SQL API and storage
format; disqualifying for a DBaaS persisting customer data. *External vector DB* — breaks the
"one database per agent, branched as a unit" thesis.

**Prototype fallback:** if the bundled libSQL build lacks the vector SQL functions, the prototype
ships brute-force cosine over `F32_BLOB`-shaped BLOB columns behind the same `vectors.*` API
(fine at agent scale), and the ANN index is enabled when the engine build provides it.
