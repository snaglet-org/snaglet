# Search quality evaluation

The default search-quality integration evaluation uses deterministic mocked
embeddings and is safe for CI. This measures mocked pipeline behavior, not
semantic quality. In particular, production deliberately rejects mock providers
for semantic file search, so file cases measure grep fallback. The real opt-in
is needed to measure semantic file retrieval. Table-row cases query fixture
rows in the built-in docs table, not custom table entries.

Real local embeddings are an explicit,
test-only opt-in:

```sh
SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS=1 pnpm exec jest \
  --selectProjects integration:server \
  --runTestsByPath tests/integration/apps/server/search/searchQualityEval.test.ts \
  --maxWorkers=2
```

Do **not** enable this variable in the normal CI command. The real path is
intended for a developer-run comparison against the same authored query set;
it requires the per-file PostgreSQL test harness environment and a disposable
`SNAGLET_HOME`. The child validates `NODE_ENV=test`, matching
`SNAGLET_PG_TEST_DATABASE`/`SNAGLET_DATABASE_URL`, and matching `SNAGLET_PG_TEST_HOME`/`SNAGLET_HOME`
before importing database-backed modules.

Real inference is local ONNX inference using the repository's pinned
`nomic-embed-text-v1.5` model (768 dimensions). Ensure the repository's
embedding/model asset setup is available before running; this evaluation does
not promise to download model assets automatically. It consumes CPU, memory,
disk, and wall-clock time. Runtime varies with machine and cache state; no
hosted API or invented dollar estimate is assumed. The real-eval child avoids
using an inherited reranker model by pointing reranker file settings into the
disposable test home; verify the local reranker configuration before relying on
reranking behavior.

This evaluation is not a migration, server, database provisioning, or paid
benchmark script. The command must be able to resolve `rg` on `PATH`, as the
search-quality setup uses it when checking repository assets. Jest starts and
tears down the disposable PostgreSQL harness for the per-file test. The same
query fixtures and scoring metrics are shared with the default mock evaluation.

Each run prints its reports to the test output. To save them as files, set
`SNAGLET_SEARCH_EVAL_ARTIFACT_DIR` to a directory outside the repository (created if
missing): the suite writes `original-fallback.json` and `harder-fallback.json`
for the plain-text fallback used when `rg` is not on `PATH`, plus
`original-rg.json` and `harder-rg.json` when ripgrep is available. How search
behaves without ripgrep is in
[Search and embeddings](../../../docs/architecture.md#search-and-embeddings).
