/**
 * NlpEntityService — public facade for message NLP-entity enrichment.
 *
 * Mirrors `EmbeddingService.syncMessageEmbedding`: a fire-and-forget write
 * hook called right after `Messages.create()` on the chat-send path (see
 * `chatHandlers.ts`, next to the `syncMessageEmbedding` call it's modeled on).
 * Extracts (person|place|org) entities via the on-device Apple NLTagger
 * helper (`./nlp`) and stores them on `messages.search_entity_terms`, so
 * keyword search picks up entity terms the tagger resolved from the text,
 * widening recall beyond a literal content substring match.
 *
 * Strictly additive. `messages.search_text` is a stored
 * generated column over `content || ' ' || search_entity_terms`, so the base
 * content vector exists for every message — independent of this service, of
 * the platform, and of whether the tagger found anything (many message
 * writers never call this hook). This hook only ever widens what is indexed.
 */

import { Messages } from '@snaglet/db/tables/messages';
import { extractEntities } from './nlp';
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';

export async function syncMessageEntities(messageId: string, content: string): Promise<void> {
  if (!isAutomaticLocalIntelligenceEnabled()) return;
  const { entities } = await extractEntities(content);
  // No entities (non-mac/CI, unbuilt helper, a timed-out request, or a message
  // with no recognizable names) — skip the write. The generated vector already
  // indexes the content either way, so this only avoids a pointless UPDATE.
  if (entities.length === 0) return;
  await Messages.updateSearchEntityTerms(messageId, entities);
}
