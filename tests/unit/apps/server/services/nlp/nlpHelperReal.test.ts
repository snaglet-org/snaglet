/**
 * snaglet-nlp-helper — real NLTagger/NLLanguageRecognizer round trip against the
 * actual compiled Swift binary (no fake, no mocks). Proves genuine on-device
 * entity extraction end-to-end through NlpHelperClient's real framing.
 *
 * Gated exactly like LocalEmbedderService.test.ts's real-ONNX-model suite:
 * runs only on darwin and only when the binary is already built (build it
 * with `pnpm nlp:build`, or let `ensureNlpHelperBinary()` build it on demand
 * elsewhere first) — skipped-green everywhere else (Linux CI, an unbuilt
 * checkout) rather than failing.
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import { NlpHelperClient } from '@server/services/nlp/NlpHelperClient';
import { nlpHelperBinaryPath } from '@server/services/nlp/nlpHelperResolver';

const isDarwin = process.platform === 'darwin';
const helperBuilt = existsSync(nlpHelperBinaryPath());

(isDarwin && helperBuilt ? describe : describe.skip)(
  'snaglet-nlp-helper — real NLTagger round trip',
  () => {
    it('extracts person/place/org entities and detects language from real text', async () => {
      const client = new NlpHelperClient({ command: nlpHelperBinaryPath() });
      try {
        const result = await client.extractEntities(
          'Barack Obama visited Paris and met with representatives from Acme Corp yesterday.'
        );
        expect(result.entities).toEqual(
          expect.arrayContaining(['Barack Obama', 'Paris', 'Acme Corp'])
        );
        expect(result.language).toBe('en');
      } finally {
        await client.shutdown();
      }
    });

    it('survives embedded newlines and handles empty text against the real helper', async () => {
      const client = new NlpHelperClient({ command: nlpHelperBinaryPath() });
      try {
        const multiline = await client.extractEntities('line one\nline two, mentioning Jane Doe');
        expect(multiline.entities).toContain('Jane Doe');

        const empty = await client.extractEntities('');
        expect(empty).toEqual({ entities: [], language: null });
      } finally {
        await client.shutdown();
      }
    });
  }
);
