import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Containers } from '@snaglet/db/tables/containers';
import { Memories } from '@snaglet/db/tables/memories';
import { Messages } from '@snaglet/db/tables/messages';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { Threads } from '@snaglet/db/tables/threads';
import type { NodeRunner } from '@snaglet/db/tables/nodes';

const query = jest.fn();
const runner: NodeRunner = { query };

beforeEach(() => {
  query.mockReset();
});

describe('thread purge model transaction runners', () => {
  it('deletes a container subtree through the supplied runner', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(Containers.delete('container-1', runner)).resolves.toBe(true);

    expect(query).toHaveBeenCalledWith('DELETE FROM public.nodes WHERE id = $1 AND type = $2', [
      'container-1',
      'container',
    ]);
  });

  it('deletes message nodes through the supplied runner', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'message-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(Messages.deleteByThread('thread-1', runner)).resolves.toBe(1);

    expect(query.mock.calls[0]?.[0]).toContain('FROM "public"."messages"');
    expect(query.mock.calls[1]).toEqual([
      'DELETE FROM public.nodes WHERE id = ANY($1::text[])',
      [['message-1']],
    ]);
  });

  it('deletes memory nodes through the supplied runner and relies on node cascades', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'memory-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(Memories.deleteByThread('thread-1', runner)).resolves.toBe(1);

    expect(query.mock.calls[0]?.[0]).toContain('FROM "public"."memories"');
    expect(query.mock.calls[1]).toEqual([
      'DELETE FROM public.nodes WHERE id = ANY($1::text[])',
      [['memory-1']],
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('deletes summary nodes through the supplied runner and relies on node cascades', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'summary-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(ThreadSummaries.deleteByThread('thread-1', runner)).resolves.toBe(true);

    expect(query.mock.calls[0]?.[0]).toContain('FROM "public"."thread_summaries"');
    expect(query.mock.calls[1]).toEqual([
      'DELETE FROM public.nodes WHERE id = ANY($1::text[])',
      [['summary-1']],
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('resets the thread watermark through the supplied runner', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await Threads.resetLastMessageAt('thread-1', runner);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('SET last_message_at = NULL'), [
      'thread-1',
    ]);
  });
});
