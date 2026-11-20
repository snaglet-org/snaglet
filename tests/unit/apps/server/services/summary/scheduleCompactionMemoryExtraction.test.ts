/**
 * scheduleCompactionMemoryExtraction — the shared trigger every
 * summary-writing path calls (unit).
 *
 * extractMemoriesFromCompaction is mocked; these tests pin the helper's
 * contract:
 *  - extraction fires only for a summary that was actually written
 *    ('generated'), never for a skipped/failed/no-op pass
 *  - one compaction is mined once (summary-id watermark), so two paths racing
 *    over the same summary do not extract twice
 *  - it is synchronous, returns void, and never throws or blocks — not even
 *    when extraction rejects or the result callback throws
 */

import { beforeEach, describe, expect, it } from '@jest/globals';
import type { GenerateSummaryOutcome } from '@server/services/SummaryService';

const extractMemoriesFromCompaction = jest.fn();

jest.mock('@server/services/summary/memoryExtraction', () => ({
  extractMemoriesFromCompaction: (...args: unknown[]) => extractMemoriesFromCompaction(...args),
}));

import { logger } from '@server/config/logger';
import {
  resetCompactionMemoryExtractionWatermark,
  scheduleCompactionMemoryExtraction,
  scheduleHistoryCompactionMemoryExtraction,
} from '@server/services/summary/scheduleCompactionMemoryExtraction';

const THREAD = 'thread-1';
const AGENT = 'agent-1';

const WROTE: GenerateSummaryOutcome = {
  status: 'generated',
  providerId: 'anthropic',
  modelId: 'claude-test',
  summaryId: 'sum-42',
};

/** Let the detached extraction promise settle. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('scheduleCompactionMemoryExtraction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCompactionMemoryExtractionWatermark();
    extractMemoriesFromCompaction.mockResolvedValue({
      saved: 2,
      proposed: 1,
      duplicates: 0,
      dropped: 0,
    });
  });

  it('extracts when a summary was written, passing the thread, agent and name map', async () => {
    const agentNameMap = new Map([[AGENT, 'Venus']]);

    scheduleCompactionMemoryExtraction({
      threadId: THREAD,
      agentId: AGENT,
      outcome: WROTE,
      agentNameMap,
    });
    await flush();

    expect(extractMemoriesFromCompaction).toHaveBeenCalledTimes(1);
    expect(extractMemoriesFromCompaction).toHaveBeenCalledWith({
      threadId: THREAD,
      agentId: AGENT,
      agentNameMap,
    });
  });

  it('returns void synchronously, before extraction settles', () => {
    let settled = false;
    extractMemoriesFromCompaction.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve({ saved: 1, proposed: 0, duplicates: 0, dropped: 0 });
          }, 10)
        )
    );

    const returned = scheduleCompactionMemoryExtraction({
      threadId: THREAD,
      agentId: AGENT,
      outcome: WROTE,
    });

    // Not a promise, and the caller is not made to wait for the model.
    expect(returned).toBeUndefined();
    expect(settled).toBe(false);
  });

  it('reports the counts through onResult when something was written', async () => {
    const onResult = jest.fn();

    scheduleCompactionMemoryExtraction({
      threadId: THREAD,
      agentId: AGENT,
      outcome: WROTE,
      onResult,
    });
    await flush();

    expect(onResult).toHaveBeenCalledWith({
      saved: 2,
      proposed: 1,
      duplicates: 0,
      dropped: 0,
    });
  });

  it('does not call onResult when extraction wrote nothing', async () => {
    extractMemoriesFromCompaction.mockResolvedValue({
      saved: 0,
      proposed: 0,
      duplicates: 0,
      dropped: 3,
    });
    const onResult = jest.fn();

    scheduleCompactionMemoryExtraction({
      threadId: THREAD,
      agentId: AGENT,
      outcome: WROTE,
      onResult,
    });
    await flush();

    expect(onResult).not.toHaveBeenCalled();
  });

  describe('only on a written summary', () => {
    const skips: Array<GenerateSummaryOutcome> = [
      { status: 'skipped', reason: 'not-due' },
      { status: 'skipped', reason: 'no-new-messages' },
      { status: 'skipped', reason: 'in-flight' },
      { status: 'skipped', reason: 'debounced' },
      { status: 'skipped', reason: 'quality-floor' },
      { status: 'skipped', reason: 'generation-failed' },
      { status: 'skipped', reason: 'compact-conversations-disabled' },
      { status: 'skipped', reason: 'daily-cap-reached' } as GenerateSummaryOutcome,
      { status: 'skipped', reason: 'no-credentials' } as GenerateSummaryOutcome,
    ];

    it.each(skips.map((outcome) => [(outcome as { reason: string }).reason, outcome] as const))(
      'does not extract for a skipped summary (%s)',
      async (_reason, outcome) => {
        scheduleCompactionMemoryExtraction({ threadId: THREAD, agentId: AGENT, outcome });
        await flush();

        expect(extractMemoriesFromCompaction).not.toHaveBeenCalled();
      }
    );
  });

  describe('once per compaction', () => {
    it('skips a summary id already mined in this process', async () => {
      scheduleCompactionMemoryExtraction({ threadId: THREAD, agentId: AGENT, outcome: WROTE });
      scheduleCompactionMemoryExtraction({ threadId: THREAD, agentId: AGENT, outcome: WROTE });
      await flush();

      expect(extractMemoriesFromCompaction).toHaveBeenCalledTimes(1);
    });

    it('guards synchronously, so two racing paths cannot both extract', async () => {
      // Both callers fire before either extraction resolves — the watermark is
      // claimed before the await, so the second one still loses.
      extractMemoriesFromCompaction.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ saved: 1 }), 20))
      );

      scheduleCompactionMemoryExtraction({ threadId: THREAD, agentId: AGENT, outcome: WROTE });
      scheduleCompactionMemoryExtraction({ threadId: THREAD, agentId: AGENT, outcome: WROTE });

      expect(extractMemoriesFromCompaction).toHaveBeenCalledTimes(1);
      await flush();
    });

    it('a different summary id is a different compaction and does extract', async () => {
      scheduleCompactionMemoryExtraction({ threadId: THREAD, agentId: AGENT, outcome: WROTE });
      scheduleCompactionMemoryExtraction({
        threadId: THREAD,
        agentId: AGENT,
        outcome: { ...WROTE, summaryId: 'sum-43' },
      });
      await flush();

      expect(extractMemoriesFromCompaction).toHaveBeenCalledTimes(2);
    });
  });

  describe('never throws, never blocks', () => {
    it('contains a rejected extraction instead of raising an unhandled rejection', async () => {
      extractMemoriesFromCompaction.mockRejectedValue(new Error('extraction exploded'));

      expect(() =>
        scheduleCompactionMemoryExtraction({ threadId: THREAD, agentId: AGENT, outcome: WROTE })
      ).not.toThrow();
      await flush();
      await flush();
    });

    it('contains a synchronous throw from extraction', async () => {
      extractMemoriesFromCompaction.mockImplementation(() => {
        throw new Error('exploded before returning a promise');
      });

      expect(() =>
        scheduleCompactionMemoryExtraction({ threadId: THREAD, agentId: AGENT, outcome: WROTE })
      ).not.toThrow();
      await flush();
    });

    it('contains a throwing onResult callback', async () => {
      const onResult = jest.fn(() => {
        throw new Error('broadcast exploded');
      });

      scheduleCompactionMemoryExtraction({
        threadId: THREAD,
        agentId: AGENT,
        outcome: WROTE,
        onResult,
      });
      await flush();
      await flush();

      expect(onResult).toHaveBeenCalled();
    });
  });
});

describe('scheduleHistoryCompactionMemoryExtraction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCompactionMemoryExtractionWatermark();
    extractMemoriesFromCompaction.mockResolvedValue({
      saved: 0,
      proposed: 0,
      duplicates: 0,
      dropped: 0,
    });
  });

  it('mines exactly the folded units, detached', async () => {
    const agentNameMap = new Map([[AGENT, 'Venus']]);
    const result = scheduleHistoryCompactionMemoryExtraction({
      threadId: THREAD,
      agentId: AGENT,
      foldedUnitIds: ['message-1', 'run-2'],
      agentNameMap,
    });
    expect(result).toBeUndefined();
    await flush();
    expect(extractMemoriesFromCompaction).toHaveBeenCalledWith({
      threadId: THREAD,
      agentId: AGENT,
      agentNameMap,
      foldedUnitIds: ['message-1', 'run-2'],
    });
  });

  it('reports what a fold saved, so the thread can say so, and stays quiet when nothing was', async () => {
    const onResult = jest.fn();
    scheduleHistoryCompactionMemoryExtraction({
      threadId: THREAD,
      agentId: AGENT,
      foldedUnitIds: ['message-quiet'],
      onResult,
    });
    await flush();
    expect(onResult).not.toHaveBeenCalled();

    extractMemoriesFromCompaction.mockResolvedValue({
      saved: 2,
      proposed: 1,
      duplicates: 0,
      dropped: 0,
    });
    scheduleHistoryCompactionMemoryExtraction({
      threadId: THREAD,
      agentId: AGENT,
      foldedUnitIds: ['message-loud'],
      onResult,
    });
    await flush();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ saved: 2, proposed: 1 }));
  });

  it('survives a reporting callback that throws, and says so in the debug log', async () => {
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined as never);
    try {
      extractMemoriesFromCompaction.mockResolvedValue({
        saved: 1,
        proposed: 0,
        duplicates: 0,
        dropped: 0,
      });
      scheduleHistoryCompactionMemoryExtraction({
        threadId: THREAD,
        agentId: AGENT,
        foldedUnitIds: ['message-throws'],
        onResult: () => {
          throw new Error('broadcast down');
        },
      });
      await flush();
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining('onResult failed: broadcast down')
      );
    } finally {
      debug.mockRestore();
    }
  });

  it('mines one fold once, even if it is reported twice', async () => {
    const args = { threadId: THREAD, agentId: AGENT, foldedUnitIds: ['message-1', 'run-2'] };
    scheduleHistoryCompactionMemoryExtraction(args);
    scheduleHistoryCompactionMemoryExtraction(args);
    await flush();
    expect(extractMemoriesFromCompaction).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an empty fold and never throws when extraction rejects', async () => {
    scheduleHistoryCompactionMemoryExtraction({
      threadId: THREAD,
      agentId: AGENT,
      foldedUnitIds: [],
    });
    expect(extractMemoriesFromCompaction).not.toHaveBeenCalled();

    extractMemoriesFromCompaction.mockRejectedValue(new Error('boom'));
    expect(() =>
      scheduleHistoryCompactionMemoryExtraction({
        threadId: THREAD,
        agentId: AGENT,
        foldedUnitIds: ['message-9'],
      })
    ).not.toThrow();
    await flush();
  });
});
