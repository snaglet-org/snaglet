# Separate Wikipedia search-evaluation corpus

Separate executable evaluation: **8 attributed excerpts, 36 authored judgments, 3 disposable fixture projects**. It runs alongside the 30-query baseline in `tests/support/searchEval/` and does not replace it. The integration suite seeds only its isolated test database, measures keyword and mock-hybrid retrieval, and cleans up its fixtures. Static snapshots require no Wikipedia network requests at runtime; real inference is opt-in.

## Files and provenance

- `source-request.txt`: exact public Wikipedia API request (`extracts|info`, `explaintext=1`, `exintro=1`).
- `source-response.json`: complete HTTP response bytes saved directly from the API, not copied from potentially truncated terminal/tool output. Contains the full retrieved introductory extracts, not full articles.
- `corpus.json`: short excerpt documents, stable logical keys, project plan, per-document provenance, revision permalinks, original-extract/excerpt SHA-256 hashes, and raw-response SHA-256.
- `queries.json`: fixed relevance judgments with literal evidence anchors and zero-based, end-exclusive Unicode character offsets into `content` (Python code-point indexing, not JavaScript UTF-16 indexing).
- `LICENSE.md`: the CC BY-SA 4.0 terms and per-article sources for the Wikipedia text in this folder, which is not under Snaglet's MIT License.

Each excerpt has its own source URL, revision ID/permalink, **Wikipedia contributors** attribution, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) license link and explicit adaptation/paragraph-selection note. `attributionNote` is the ready-to-render attribution footer. Every seeded document includes **both `content` and `attributionNote` in its body**; metadata alone is not adequate visible attribution. Keep the footer with exported copies. Query evidence text is quoted from these same attributed articles. Authored queries and rationales are not Wikipedia article text.

Excerpts retain 1–3 introductory paragraphs per document, 412–1,880 Unicode characters each. Engineering retains paragraphs 1, 2 and 4; planetary Mercury and Pollination retain paragraphs 1 and 2. The other excerpts retain their complete returned introductions. Paragraph separators are normalized; retained paragraph text is not rewritten. Full originals remain in the raw response. Plain-text extraction removes formatting, citations and images; it may retain source imperfections. These are retrieval judgments against the snapshot, not independent fact-checking of Wikipedia claims.

Revision IDs come from `info.lastrevid` in the same response as the extracts. This is a provenance snapshot, not proof that MediaWiki's independently cached extract text is byte-identical to rendering that revision; both response and hashes are retained to make the actual retrieved text auditable. Do not silently refresh these files. A deliberate refresh must review article changes, evidence offsets, relevance judgments, revision IDs and hashes together.

## Disposable fixture layout

```text
Search eval corpus [disposable parent container]
├── Wikipedia eval — Physical sciences [project]
│   ├── Mercury (planet)
│   └── Mercury (element)
├── Wikipedia eval — Living systems [project]
│   ├── Pollination
│   └── Fermentation
└── Wikipedia eval — Arts and technology [project]
    ├── Sonata
    ├── Printing press
    ├── Engineering
    └── Arch bridge
```

The logical keys in `containerPlan`/`projects` are not workspace IDs. The isolated runner creates fresh IDs, tracks them, and removes only its owned nodes. Do not create these in a person's live workspace as part of loading fixtures.

## Query contract and scoring

`intent`, `input` and `expected` align with the existing `EvalQuery` shape. Additional fields are authored metadata, not search arguments:

- `category`: 8 exact/title, 8 keyword, 8 paraphrase, 4 ambiguous/disambiguated, 4 cross-topic distractor and 4 scope-filter cases.
- `expected`: exhaustive relevant document keys **within this eight-document corpus and any stated scope**, not an ordering requirement.
- `evidence` and `rationale`: source anchors and why these judgments hold.
- `distractorKeys`: salient near-miss articles, not a second expected list.
- `scope.projectKey`: logical fixture project filter, not a literal API project/container ID.

The adapter resolves document keys to seeded doc IDs and project keys to generated project container IDs using explicit `input.container_id` subtree filters. Do not send `scope` or other metadata directly as API parameters, and do not rely on whichever project happens to be current. All 4 scoped cases have positive expected sets; scope correctness additionally requires checking that **every returned hit** belongs to the requested subtree. Existing recall/MRR metrics alone cannot prove exclusion of out-of-scope results. Empty-scope/zero-relevance cases are intentionally absent because the current scorer rejects empty expected arrays.

Unqualified `Mercury` accepts both planet and element; `bridges` accepts both Engineering and Arch bridge. The production queries scoped to different projects likewise accept both supported senses inside their respective scopes. Existing `scoreQuery` gives reciprocal-rank credit to the first of any expected results, and recall@5 uses the full expected set; do not turn an alternate valid sense into a false positive or insist on an arbitrary first-place document. No rankings were used to select judgments.

## Limits and verification

This small English-language introductory corpus is a topical stress fixture, not a representative semantic benchmark. The runner's raw reports contain measured keyword and mock-hybrid results, including estimated output tokens (not monetary costs). Mock vectors establish pipeline behavior only, not semantic improvement. No real inference or real semantic quality is claimed. Short snippets, shared terminology and manually authored queries can bias outcomes. Attribution footers are indexed with excerpt bodies consistently in both modes.

Preserve `source-response.json` byte-for-byte: its exact repository path is excluded in `.prettierignore`, and unit tests verify its SHA-256 against corpus metadata.

## Executable separate evaluation

Run `pnpm exec jest --runTestsByPath tests/unit/apps/server/search/searchWikipediaEval.test.ts tests/integration/apps/server/search/searchWikipediaEval.test.ts --maxWorkers=2` from repository root. The existing per-file disposable PostgreSQL harness owns setup/teardown; this suite does not connect to live Snaglet. Default runner mode is `keyword-baseline` (no embedding ingestion or query embeddings); integration additionally measures `mocked-hybrid-pipeline`. Both execute the same 36 authored questions with overridden effective mode, preserving authored/effective inputs in raw reports. Hash-vector results are pipeline coverage, **not semantic quality**.

`runner.ts` creates a fresh Search eval corpus parent, three project children and eight attributed document bodies. Every query has an explicit parent/project `container_id`. All displayed hits—including unknowns—are checked against the allowed subtree before scoring. Multi-relevant answers use the existing recall/MRR helpers. Low recall is a measurement, not a test failure. Partial-seed cleanup, unrelated sentinel preservation, fresh identities, embedding-free keyword runs and cleanup error propagation have integration coverage.

`runner.ts` logs each complete raw report as a `wikipediaSearchEval` JSON line; UUIDs and token counts vary across runs.

Real inference is **off by default**. Setting `SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS=1` for this integration suite launches `realEmbeddingChild.ts` outside Jest, with a ten-minute timeout and 32 MiB output bound. Both launcher and child use the original disposable-environment safety guard; CI (even an empty `CI` variable) is rejected before launch. The child validates before DB imports, uses the unavailable-reranker policy and closes its database in `finally`. Direct runner real mode also guards before seeding. Default-no-spawn, unsafe-environment rejection, bounded launch arguments and child-failure propagation are unit tested with an injected executor, not real inference. Opt-in may load/download a local model and consume substantial compute; it requires a deliberately provisioned disposable test environment and is not a free or automatic semantic-quality claim. Never point it at live Snaglet.
