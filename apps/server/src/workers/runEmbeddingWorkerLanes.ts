export interface EmbeddingWorkerLanes {
  automaticLocalIntelligenceEnabled: boolean;
  sweepAutomaticEmbeddings: () => Promise<void>;
  /** Re-embeds docs whose human edits have settled (keeps doc search fresh). */
  sweepSettledEdits: () => Promise<void>;
  /** Builds vectors of table rows for the tables that turned semantic search on. */
  sweepTableEntries?: () => Promise<void>;
}

/**
 * Run the embedding worker's lanes in order. Every lane re-embeds, so they all
 * run only when automatic local intelligence is enabled; this function owns the
 * policy boundary and execution order, the callbacks keep the worker's existing
 * per-lane error handling.
 */
export async function runEmbeddingWorkerLanes(lanes: EmbeddingWorkerLanes): Promise<void> {
  if (!lanes.automaticLocalIntelligenceEnabled) return;

  await lanes.sweepAutomaticEmbeddings();
  await lanes.sweepSettledEdits();
  await lanes.sweepTableEntries?.();
}
