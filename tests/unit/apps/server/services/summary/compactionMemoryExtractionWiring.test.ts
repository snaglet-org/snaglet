/**
 * Compaction memory-extraction wiring guard. Memory extraction runs on every
 * path that compacts a conversation, each through the one shared helper
 * (`scheduleCompactionMemoryExtraction`), so the "only on a written summary",
 * "once per compaction" and "never blocks" rules live in one place. A missing
 * call site would typecheck and pass every behavioral test, so this greps the
 * source: each summary-writing path imports and calls the helper, and none
 * reaches past it into `extractMemoriesFromCompaction`. The helper's own
 * behavior is in scheduleCompactionMemoryExtraction.test.ts.
 */

import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '../../../../../..');

const HELPER = 'scheduleCompactionMemoryExtraction';
const HELPER_MODULE = '@server/services/summary/scheduleCompactionMemoryExtraction';
const RAW_EXTRACTOR = 'extractMemoriesFromCompaction';

/** Every user-triggered path that writes a thread summary as a compaction. */
const WIRED_PATHS = {
  'manual socket compact': 'apps/server/src/services/SocketService/handlers/compactHandlers.ts',
  'per-agent REST compact route': 'apps/server/src/domains/threads/handlers/summaryHandlers.ts',
} as const;

/**
 * The automatic run-end pass writes the thread digest (search, embeddings, the thread list). It is
 * not a compaction, so it neither extracts memories nor halts the thread: both belong to the
 * compaction that folds history (the turn loop's history compactor).
 */
const RUN_END_DIGEST_PATH =
  'apps/server/src/services/SocketService/handlers/chatPhases/finalReply.ts';
const HISTORY_COMPACTION_PATH =
  'apps/server/src/services/SocketService/handlers/chatPhases/turnLoop.ts';

/** The helper module itself, which legitimately calls the raw extractor. */
const HELPER_PATH = `apps/server/src/services/summary/${HELPER}.ts`;

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

describe('compaction memory extraction wiring', () => {
  describe.each(Object.entries(WIRED_PATHS))('%s', (_label, path) => {
    const source = read(path);

    it('imports the shared helper', () => {
      expect(source).toContain(HELPER_MODULE);
    });

    it('calls the shared helper', () => {
      expect(source).toMatch(new RegExp(`${HELPER}\\s*\\(`));
    });

    it('passes the summary outcome to the helper, rather than deciding itself', () => {
      // The helper is what filters generated-vs-skipped. A call site that
      // omitted `outcome` would not compile, but one that re-implemented the
      // status check around the call would drift from the helper's rules.
      expect(source).toMatch(/outcome[,:\s]/);
    });

    it('does not call the raw extractor directly', () => {
      expect(source).not.toContain(RAW_EXTRACTOR);
    });
  });

  describe('automatic run-end digest', () => {
    const source = read(RUN_END_DIGEST_PATH);

    it('neither extracts memories nor halts the thread: a digest is not a compaction', () => {
      expect(source).not.toContain(`${HELPER}(`);
      expect(source).not.toContain(HELPER_MODULE);
      expect(source).not.toContain('haltOnSummaryFailure');
      expect(source).not.toContain(RAW_EXTRACTOR);
    });
  });

  describe('history compaction (the fold)', () => {
    const turnLoop = read(HISTORY_COMPACTION_PATH);
    const compactor = read(
      'apps/server/src/services/SocketService/handlers/chatPhases/historyCompactor.ts'
    );

    it('mines the folded units through the shared scheduler', () => {
      expect(turnLoop).toContain('scheduleHistoryCompactionMemoryExtraction');
      expect(turnLoop).not.toContain(RAW_EXTRACTOR);
    });

    it('tells the thread what the fold saved, the way the Compact button does', () => {
      const at = turnLoop.indexOf('scheduleHistoryCompactionMemoryExtraction({');
      expect(at).toBeGreaterThan(-1);
      const call = turnLoop.slice(at, at + 700);
      expect(call).toContain('onResult');
      expect(call).toContain("'socket:thread:memory-extraction'");
    });

    it('raises the summary halt when the compaction summary fails', () => {
      expect(compactor).toContain('haltOnSummaryFailure');
    });
  });

  describe('the helper', () => {
    const source = read(HELPER_PATH);

    it('is the only caller of the raw extractor', () => {
      expect(source).toContain(RAW_EXTRACTOR);
    });

    it('fires extraction detached, never awaited', () => {
      // `void extract…(` — an `await` here would put a utility-model call on
      // the compaction's critical path.
      expect(source).toMatch(new RegExp(`void ${RAW_EXTRACTOR}\\(`));
      expect(source).not.toMatch(new RegExp(`await ${RAW_EXTRACTOR}\\(`));
    });

    it('gates on a generated summary', () => {
      expect(source).toContain("outcome.status !== 'generated'");
    });
  });
});
