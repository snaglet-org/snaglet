/**
 * nlp — public facade for on-device Apple NLP entity/language extraction.
 *
 * Lazily constructs ONE NlpHelperClient for the process (mirrors how the
 * voice domain wires its singleton AppleSttEngine — see
 * apps/server/src/services/SocketService/voiceSession/engineAdapter.ts). The
 * helper binary is probed/on-demand-built exactly once, at first use, via
 * nlpHelperResolver.ensureNlpHelperBinary().
 *
 * `extractEntities` never throws — see NlpHelperClient's class doc for the
 * full fallback contract.
 */

import { NlpHelperClient } from './NlpHelperClient';
import type { EntityExtractionResult } from './NlpHelperClient';
import { ensureNlpHelperBinary } from './nlpHelperResolver';

export type { EntityExtractionResult } from './NlpHelperClient';

let singleton: NlpHelperClient | null = null;

function client(): NlpHelperClient {
  if (!singleton) {
    const command = ensureNlpHelperBinary();
    singleton = new NlpHelperClient({ command });
  }
  return singleton;
}

/** Extract (person|place|org) entities + BCP-47 dominant language for `text`. */
export function extractEntities(text: string): Promise<EntityExtractionResult> {
  return client().extractEntities(text);
}
