import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { assertSafeRealEmbeddingChildEnv } from '../../../../support/searchEval/safety';
import { chunkContent, contentBudgetChars } from '@server/services/embedding/chunkContent';
import { documentBody, codeBody } from '../../../../support/searchEval/passages/fixtures';

it.each([documentBody, codeBody])(
  'preserves every core byte and bounded overlap in a long fixture',
  (body) => {
    const chunks = chunkContent(body, { maxChars: contentBudgetChars(512) });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((c) => body.slice(c.start, c.end)).join('')).toBe(body);
    for (const chunk of chunks) {
      expect(chunk.text.endsWith(body.slice(chunk.start, chunk.end))).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(1741);
    }
  }
);

(process.env.SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS === '1' ? it : it.skip)(
  'records real local passage retrieval separately from article retrieval',
  async () => {
    assertSafeRealEmbeddingChildEnv(process.env);
    try {
      const result = await promisify(execFile)(
        process.execPath,
        [
          path.resolve('node_modules/tsx/dist/cli.mjs'),
          path.resolve('tests/support/searchEval/passages/realChild.ts'),
        ],
        { env: { ...process.env }, timeout: 600000, maxBuffer: 32 * 1024 * 1024 }
      );
      const line = result.stdout.split('\n').find((line) => line.startsWith('{"passageAudit":'));
      expect(line).toBeTruthy();
      const report = JSON.parse(line!).passageAudit;
      expect(report.queries).toHaveLength(9);
      expect(report.fileQueries).toHaveLength(9);
      expect(report.workspaceFileQueries).toHaveLength(9);
      // Pins current behavior, not the desired one: the forced winning middle
      // chunk does not produce a passage hit.
      expect(report.forcedWinningMiddleChunk.passageHit).toBe(false);
      expect(
        report.chunkAudit
          .find((x: { key: string }) => x.key === 'codeBody')
          .chunks.some((c: { tokens: number }) => c.tokens > 512)
      ).toBe(true);
      expect(
        report.winningChunks
          .find((x: { key: string }) => x.key === 'middle')
          .hits.find((x: { kind: string }) => x.kind === 'doc').chunk_index
      ).toBeGreaterThan(0);
    } catch (error) {
      const e = error as Error & { stdout?: string; stderr?: string };
      throw new Error([e.message, e.stdout, e.stderr].join('\n'));
    }
  },
  620000
);

it('keeps a sentence crossing a core boundary intact in the overlapping next chunk', () => {
  const body = 'alpha beta gamma delta. '.repeat(180);
  const chunks = chunkContent(body, { maxChars: 1740 });
  const cut = chunks[1].start;
  const span = body.slice(cut - 25, cut + 25);
  // Overlap inserts a newline at the core boundary; whitespace normalization is intentional.
  expect(chunks[1].text.replace(/\s+/g, ' ')).toContain(span.replace(/\s+/g, ' '));
  expect(chunks[1].text.length - (chunks[1].end - chunks[1].start)).toBeGreaterThan(25);
});
