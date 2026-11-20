/**
 * homeThreadGuard — a home thread (the user's DM with an agent) is refused
 * with one message, a 403 that names it; anything else passes.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const listHomeThreadIds = jest.fn(async (..._args: unknown[]): Promise<string[]> => []);
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { listHomeThreadIds: (...args: unknown[]) => listHomeThreadIds(...args) },
}));

import {
  assertNoHomeThreads,
  HOME_THREAD_ARCHIVE_MESSAGE,
  HOME_THREAD_DELETE_MESSAGE,
} from '@server/services/homeThreadGuard';

beforeEach(() => listHomeThreadIds.mockReset().mockResolvedValue([]));

describe('assertNoHomeThreads', () => {
  it('passes threads that are not home threads, asking the given runner', async () => {
    const tx = { query: jest.fn() };
    await expect(assertNoHomeThreads(['thread-a'], tx as never)).resolves.toBeUndefined();
    expect(listHomeThreadIds).toHaveBeenCalledWith(['thread-a'], tx);
  });

  it('refuses a home thread with a 403 that says to use Clear', async () => {
    listHomeThreadIds.mockResolvedValue(['thread-home']);
    await expect(assertNoHomeThreads(['thread-a', 'thread-home'])).rejects.toMatchObject({
      message: "The home thread can't be deleted. Use Clear to remove its messages.",
      statusCode: 403,
      code: 'FORBIDDEN',
      details: { threadIds: ['thread-home'] },
    });
    expect(HOME_THREAD_DELETE_MESSAGE).toBe(
      "The home thread can't be deleted. Use Clear to remove its messages."
    );
  });

  it('says archive when archiving is what was refused', async () => {
    listHomeThreadIds.mockResolvedValue(['thread-home']);
    await expect(
      assertNoHomeThreads(['thread-home'], undefined, HOME_THREAD_ARCHIVE_MESSAGE)
    ).rejects.toThrow("The home thread can't be archived. Use Clear to remove its messages.");
  });
});
