import { describe, expect, it } from '@jest/globals';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';
import {
  buildRunSummaryInstructions,
  buildRunSummaryPrompt,
  renderRunSpanForSummary,
} from '@server/services/summary/runSummaryPrompts';

function writeCycle(i: number, contentChars: number): ProviderMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `call-${i}`,
          name: 'action',
          input: {
            tool: 'file_write',
            params: { path: `apps/server/src/file-${i}.ts`, content: 'c'.repeat(contentChars) },
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `call-${i}`,
          content: `${'o'.repeat(contentChars)} Tests: 3 failed, 41 passed`,
        },
      ],
    },
  ];
}

describe('renderRunSpanForSummary', () => {
  it('names the real tool, keeps short arguments whole and clips long ones', () => {
    const text = renderRunSpanForSummary(writeCycle(1, 5_000), 20_000);
    expect(text).toContain('[call] file_write path=apps/server/src/file-1.ts content=ccc');
    expect(text).toMatch(/content=c+… \[\+\d+ chars\]/);
    // Results keep their tail: the summary line of a test run survives.
    expect(text).toContain('[result] file_write:');
    expect(text).toContain('Tests: 3 failed, 41 passed');
  });

  it('marks failed results and messages received mid-run', () => {
    const span: ProviderMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c1', name: 'run_command', input: { command: 'pnpm test' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'exit 1', is_error: true },
          { type: 'text', text: 'Test User: use the v2 parser instead' },
        ],
      } as unknown as ProviderMessage,
    ];
    const text = renderRunSpanForSummary(span, 10_000);
    expect(text).toContain('[call] run_command command=pnpm test');
    expect(text).toContain('[error] run_command: exit 1');
    expect(text).toContain('[message] Test User: use the v2 parser instead');
  });

  it('fits the budget: caps shrink first, then the middle is dropped; same input, same text', () => {
    const span = Array.from({ length: 40 }, (_, i) => writeCycle(i, 3_000)).flat();
    const a = renderRunSpanForSummary(span, 8_000);
    expect(a.length).toBeLessThanOrEqual(8_100);
    expect(a).toContain('steps omitted to fit');
    expect(a).toContain('file-0.ts');
    expect(a).toContain('file-39.ts');
    expect(renderRunSpanForSummary(span, 8_000)).toBe(a);
  });
});

describe('run summary prompt', () => {
  it('asks for the task-state sections with a word cap under the token cap', () => {
    const instructions = buildRunSummaryInstructions(2_048);
    for (const label of [
      'Goal:',
      'Next step:',
      'Files:',
      'Commands and results:',
      'Decisions:',
      'Open errors:',
      'Instructions received:',
    ]) {
      expect(instructions).toContain(label);
    }
    expect(instructions).toContain('under 921 words');
  });

  it('includes the goal, the earlier summary when there is one, and the steps', () => {
    const prompt = buildRunSummaryPrompt({
      goal: 'Update the parser.',
      previousSummary: 'Goal: update the parser. Files: none yet.',
      transcript: '[call] file_read path=src/parser.ts',
      foldedMessages: 2,
    });
    expect(prompt).toContain('TASK (the request that started this run):\nUpdate the parser.');
    expect(prompt).toContain('EARLIER SUMMARY OF THIS RUN:\nGoal: update the parser.');
    expect(prompt).toContain('STEPS TO SUMMARIZE (2 messages, oldest first):');
    expect(
      buildRunSummaryPrompt({
        goal: 'g',
        previousSummary: null,
        transcript: 't',
        foldedMessages: 1,
      })
    ).not.toContain('EARLIER SUMMARY');
  });
});
