import { describe, expect, it, jest } from '@jest/globals';

const mockMessageCreate = jest.fn();

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { create: mockMessageCreate },
}));

import getClarification from '@server/services/ToolService/tools/threads/ask/tool';

describe('get_clarification tool', () => {
  it('returns the answers only as the tool result without creating thread messages', async () => {
    const requestClarification = jest.fn(async () => ({
      status: 'answered' as const,
      answers: {
        scope: { selected: ['repository'] },
        reason: { text: 'Prepare the release' },
      },
    }));

    const result = await getClarification(
      {
        preamble: 'Before I continue',
        questions: [
          {
            id: 'scope',
            prompt: 'Which scope?',
            type: 'single_select',
            options: ['repository', 'file'],
          },
          { id: 'reason', prompt: 'Why?', type: 'text' },
        ],
      },
      {},
      {
        agentId: 'vega',
        threadId: 'thread-1',
        requestClarification,
      }
    );

    expect(requestClarification).toHaveBeenCalledWith({
      preamble: 'Before I continue',
      questions: [
        {
          id: 'scope',
          prompt: 'Which scope?',
          type: 'single_select',
          options: ['repository', 'file'],
        },
        { id: 'reason', prompt: 'Why?', type: 'text' },
      ],
    });
    expect(result).toBe(
      'The user answered:\n- Which scope? [scope]: repository\n- Why? [reason]: Prepare the release'
    );
    expect(mockMessageCreate).not.toHaveBeenCalled();
  });
});
