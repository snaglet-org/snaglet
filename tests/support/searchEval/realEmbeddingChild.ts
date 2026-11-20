import { assertSafeRealEmbeddingChildEnv } from './safety';

/**
 * tsx entrypoint for the opt-in real local-embedding evaluation. Keep this
 * guard as the first executable operation: importing the runner imports the
 * database layer and is forbidden until the per-file test environment is
 * validated.
 */
async function main(): Promise<void> {
  assertSafeRealEmbeddingChildEnv(process.env);
  // Force the test-only reranker path to degrade closed over the disposable
  // home. This prevents an inherited or globally cached cross-encoder bundle
  // from being used by a standalone tsx child; reorderByRerank preserves
  // incoming order when these files are unavailable.
  const unavailableReranker = `${process.env.SNAGLET_HOME}/search-eval-reranker-unavailable`;
  process.env.SNAGLET_RERANKER_MODEL_FILE = unavailableReranker;
  process.env.SNAGLET_RERANKER_VOCAB_FILE = unavailableReranker;
  process.env.SNAGLET_RERANKER_TOKENIZER_CONFIG_FILE = unavailableReranker;
  const [{ runSearchEval }, { closeDatabase }] = await Promise.all([
    import('./runner'),
    import('@snaglet/db'),
  ]);
  try {
    const report = await runSearchEval({ realEmbeddings: true });
    // runner.ts also emits this report for direct callers; retain a stable
    // child-process JSON record for callers that consume stdout.
    process.stdout.write(`${JSON.stringify({ searchQualityEval: report }, null, 2)}\n`);
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
