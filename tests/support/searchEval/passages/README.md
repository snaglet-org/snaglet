# Long passage audit

Fixtures for `tests/integration/apps/server/search/searchPassageAudit.test.ts`:
one authored multi-section document and one TypeScript file (`fixtures.ts`),
each with start, middle and end answer queries.

## Running

The default run checks core coverage and boundary overlap without ONNX. The
real-embedding audit is opt-in; run it from the repo root:

```sh
SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS=1 pnpm exec jest --selectProjects integration:server --runTestsByPath tests/integration/apps/server/search/searchPassageAudit.test.ts --maxWorkers=2
```

The opt-in run starts `realChild.ts` outside Jest. The child checks the
disposable PostgreSQL harness guard before any database import, checks local
model readiness, and disables reranking by pointing the reranker at nonexistent
paths in the test home. It requests no downloads or remote providers and
deletes only the hierarchy and temporary directory it created. It prints its
report as a `passageAudit` JSON line. With `SNAGLET_SEARCH_EVAL_ARTIFACT_DIR` set to
a directory outside the repository (created if missing), it also saves the
report there as `passage-audit.json`, a diagnostic capture rather than a golden
snapshot; the writer replaces generated ids, the temporary directory and the
home directory with neutral placeholders before saving.

## Scope and interpretation

One authored 5,983-character multisection document and one 5,132-character TypeScript fixture, with three corresponding start/middle/end answer queries. This is a plumbing and tokenizer audit, **not a discriminative retrieval benchmark**: there is only one target document/file per scope and no distractor corpus. Answers are exact complete sentence matches against canonical rendered output; short excerpts can fail this strict metric. A separate synthetic boundary test checks whitespace-normalized overlap across a core cut. Dense punctuation is a tokenizer stress fixture, not a representative language distribution.

Model: local `nomic-embed-text-v1.5`, 768 dimensions, pinned revision `e9b6763023c676ca8431644204f50c2b100d9aab`. Native support 8192 tokens; runtime and seeded context budget are 512. Actual WordPiece counts include `search_document: ` and CLS/SEP. Counting uses `encodeSingle` with a deliberately large ceiling (100000), avoiding the runtime truncation which would conceal over-budget chunks.

## Measured

- Character budget 1740. Doc chunk chars/tokens: 1525/198, 1614/203, 1677/217, 1683/217. Core ranges: 0–1525, 1525–2967, 2967–4472, 4472–5983.
- Code: 1543/749, 1714/837, 1717/836, 668/337. Three chunks exceed 512 even though all pass the character budget. Dense punctuation: 1532/1307, 1701/1464, 1701/1464, 490/426. The runtime silently truncates; overflow-error retries cannot detect it.
- Core spans cover source without gaps; boundary overlap test passes. Heading context is **not inherited**: document chunk 1 contains no markdown heading; dense chunks 1–3 likewise lose their only governing heading. Heading-boundary preference is not heading preservation.
- Direct real vector candidates choose doc chunks 0 / 2 / 3 and code chunks 0 / 1 / 2 for start / middle / end. Thus the later answer-bearing chunks can win.
- Canonical docs: keyword article 0/3, passage 0/3; semantic article 3/3, passage 0/3; hybrid article 3/3, passage 0/3.
- Canonical `kind:workspace,kinds:[file]`: same 0/3, 3/3, 3/3 article results and 0/3 passages in all modes. Returned file cards have metadata, no passage or matched-chunk range.
- `kind:files` ignores the requested mode for this fixture: all three modes return `matchedOn:semantic`, article 3/3 and passage 0/3. **Do not label its keyword result a lexical baseline.** It returns path/score JSON without passage content.
- Forced winning-middle-chunk hydration also returns the opening 220 characters, so `passageHit` is `false`. The test asserts that current behavior as a characterization, not as the desired contract: a green run does not mean passage hydration is correct.

## Code path

`embedding/EmbeddingOrchestrator.ts:generateEmbeddingChunks` is shared by docs and `embedding/fileContentEmbedding.ts`. `chunkContent.ts` uses 4 chars/token × .85, balanced structural cuts, previous-tail overlap (~10%). `LocalEmbedderService.ts` calls `WordPieceTokenizer.encodeSingle(...,512)`, which truncates without throwing.

Doc-only canonical search in `ToolService/handlers/search/workspaceSearch/workspaceSearch.ts` routes through `services/search/nodeSearch.ts`, where MIN(distance) groups by node and discards winning offsets. `hydrateHybridDocHits` in `hydration.ts` uses `ts_headline` against the whole document rather than the vector passage; these paraphrase queries show an opening fragment. Mixed/file workspace semantic candidates _do_ select offsets in `semanticCandidates.ts`, but `semantic.ts` maps vector hits into rank channels without those fields; `hydrateSemanticHits` has file-field support that never receives them in this path. Its doc branch independently always takes the opening 220 chars. The file-specific `kind:files` adapter returns only paths/scores.

## What the fixture does not cover

It does not show semantic quality across alternative documents, perfect boundary answer recall, Unicode offset correctness, or every content type. It uses no reranker and no paid embeddings. A real-model result characterizes this pinned model, not a general quality threshold.
