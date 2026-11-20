/**
 * Thread-summary generation is enabled by default for backward compatibility.
 * Setting COMPACT_CONVERSATIONS=false is a hard process-level override: no
 * automatic, backfill, or manually forced path may generate a thread_summary.
 *
 * Read the environment at call time rather than module load so every entry
 * point shares one policy and tests can restore process.env without resetting
 * the module graph.
 */
export function isConversationCompactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMPACT_CONVERSATIONS?.trim().toLowerCase() !== 'false';
}

export const COMPACTION_DISABLED_MESSAGE =
  'Conversation compaction is disabled by COMPACT_CONVERSATIONS=false.';
