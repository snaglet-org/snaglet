import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { isEmbeddableMessage } from '@server/services/embedding/messageEligibility';

const query = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('@snaglet/db/db', () => ({ getDb: () => ({ query }) }));
import {
  auditInjectedMessageEmbeddings,
  removeInjectedMessageEmbeddings,
} from '@server/services/embedding/injectedMessageCleanup';

describe('message eligibility', () => {
  const ordinary = {
    role: 'user' as const,
    messageType: 'message' as const,
    injectedDuringRun: false,
    metadata: null,
  };
  it('preserves ordinary conversation and questions, including text mentioning injections', () => {
    expect(isEmbeddableMessage(ordinary)).toBe(true);
    expect(isEmbeddableMessage({ ...ordinary, messageType: 'question' })).toBe(true);
  });
  it('rejects persisted injection metadata and thread events', () => {
    expect(isEmbeddableMessage({ ...ordinary, injectedDuringRun: true })).toBe(false);
    expect(isEmbeddableMessage({ ...ordinary, metadata: { injected_during_run: true } })).toBe(
      false
    );
    expect(isEmbeddableMessage({ ...ordinary, messageType: 'thread_event' })).toBe(false);
  });
  it.each(['timeout', 'model_failure', 'rate_limit', 'runtime', 'aborted'])(
    'keeps injected run errors: %s',
    (kind) => {
      expect(
        isEmbeddableMessage({
          ...ordinary,
          injectedDuringRun: true,
          metadata: { injected_during_run: true, run_error: { kind } },
        })
      ).toBe(true);
    }
  );
  it('keeps only the explicit abort event exception', () => {
    expect(
      isEmbeddableMessage({
        ...ordinary,
        messageType: 'thread_event',
        injectedDuringRun: true,
        metadata: { event_kind: 'agent_run_aborted' },
      })
    ).toBe(true);
    expect(
      isEmbeddableMessage({
        ...ordinary,
        messageType: 'thread_event',
        metadata: { event_kind: 'agent_run_ended' },
      })
    ).toBe(false);
  });
});

describe('reviewed historical cleanup', () => {
  beforeEach(() => query.mockReset());
  it('audits without deleting', async () => {
    query.mockResolvedValue({ rows: [{ node_id: 'message-example', chunks: 2 }] });
    expect(await auditInjectedMessageEmbeddings()).toHaveLength(1);
    expect(query.mock.calls[0][0]).not.toContain('DELETE');
  });
  it('does nothing without reviewed IDs', async () => {
    expect(await removeInjectedMessageEmbeddings([])).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
  it('limits deletion to reviewed IDs and rechecks eligibility', async () => {
    query.mockResolvedValue({ rowCount: 2 });
    expect(await removeInjectedMessageEmbeddings(['message-example'])).toBe(2);
    expect(query.mock.calls[0][0]).toContain('USING public.messages m');
    expect(query.mock.calls[0][0]).toContain('injected_during_run');
    expect(query.mock.calls[0][1]).toEqual([['message-example']]);
  });
});
