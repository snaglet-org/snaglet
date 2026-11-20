/**
 * Shared doc-embedding helpers, used by the HTTP docs route (create) and the
 * agent doc tools (create / edit / snapshot / bulk-import / restore) so every
 * discrete doc write embeds immediately with an identical content blob.
 *
 * The blob format (title + "\n\n" + content) mirrors the worker's stale-sweep
 * SQL and the reembed pipeline, so inline and bulk paths produce the same
 * content hash — a doc embedded inline is then a no-op for the sweep.
 */
import { embedNodeNow } from './EmbeddingOrchestrator';

/** Concatenate a doc's title + content for embedding. */
export function docBlobForEmbedding(
  title: string | null | undefined,
  content: string | null | undefined
): string {
  return [title?.trim() ?? '', content?.trim() ?? ''].filter((p) => p.length > 0).join('\n\n');
}

/** Fire-and-forget immediate embed for a discrete doc write. */
export function embedDocNow(
  docId: string,
  title: string | null | undefined,
  content: string | null | undefined
): void {
  embedNodeNow(docId, docBlobForEmbedding(title, content));
}
