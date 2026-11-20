import { describe, expect, it } from '@jest/globals';
import type { ProviderMessage } from '@server/services/ProviderChatService';
import { buildSummarizerInput } from '@server/services/contextWindow/summarizerInput';

const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: 'tool_use', id, name, input }) as const;
const cycle = (
  name: string,
  input: Record<string, unknown>,
  result: string,
  isError = false
): ProviderMessage[] => [
  { role: 'assistant', content: [toolUse('t1', name, input)] } as ProviderMessage,
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: result, is_error: isError }],
  } as ProviderMessage,
];

describe('buildSummarizerInput — messages', () => {
  it('keeps every message whole, with no 150- or 80-character cuts', () => {
    const long = 'The decision was to keep the retry budget at three. '.repeat(40).trim();
    const out = buildSummarizerInput([
      { role: 'user', content: long },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: long },
          toolUse('t1', 'file', { op: 'read', path: 'a.ts' }),
        ],
      } as ProviderMessage,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: long },
    ]);
    expect(out.split(long).length - 1).toBe(3);
    expect(out).not.toContain('…');
  });
});

describe('buildSummarizerInput — tool calls', () => {
  it('a write keeps its target and the ids it returned, not the body it sent', () => {
    const body = 'B'.repeat(5000);
    const result = 'updated 1: 11111111-1111-4111-8111-111111111111 (rev 3f9e1c2a)';
    const out = buildSummarizerInput(
      cycle('doc', { op: 'update', id: 'doc-1111111111111-aaaaaaaaa', content: body }, result)
    );
    expect(out).toContain('doc-1111111111111-aaaaaaaaa');
    expect(out).toContain(`op="update"`);
    expect(out).toContain(result);
    expect(out).not.toContain(body);
    expect(out).toContain('5000 chars');
  });

  it('an error keeps its message whole', () => {
    const message = ('error 409: ' + 'the row changed under you; '.repeat(30)).trim();
    const out = buildSummarizerInput(
      cycle('table', { op: 'write', table: 'Tasks' }, message, true)
    );
    expect(out).toContain(message);
  });

  it('a short read keeps a short note', () => {
    const out = buildSummarizerInput(
      cycle('file', { op: 'read', path: 'src/a.ts' }, 'const a = 1;')
    );
    expect(out).toContain('src/a.ts');
    expect(out).toContain('const a = 1;');
  });

  it('bulky read output becomes a reference to what can be re-fetched', () => {
    const dump = 'line of a big file\n'.repeat(500);
    const out = buildSummarizerInput(cycle('file', { op: 'read', path: 'src/big.ts' }, dump));
    expect(out).not.toContain('line of a big file\nline of a big file');
    expect(out).toContain('src/big.ts');
    expect(out).toMatch(/omitted/);
    expect(out).toContain(`${dump.trim().length} chars`);
  });

  it('a bulky web page points at its url', () => {
    const page = '<html>' + 'x'.repeat(30_000);
    const out = buildSummarizerInput(
      cycle('web_fetch', { url: 'https://example.com/policy' }, page)
    );
    expect(out).toContain('https://example.com/policy');
    expect(out).not.toContain('xxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('a mid-sized search result keeps its head and says how long it was', () => {
    const hits = 'result line about the watchers work\n'.repeat(30);
    const out = buildSummarizerInput(cycle('search', { query: 'watchers' }, hits));
    expect(out).toContain('result line about the watchers work');
    expect(out).toContain(`${hits.trim().length} chars`);
    expect(out.length).toBeLessThan(hits.length);
  });
});

describe('buildSummarizerInput — never a prior summary', () => {
  it('leaves out a compaction summary message and an in-run summary message', () => {
    const out = buildSummarizerInput([
      { role: 'user', content: '[Historical context summary — earlier turns folded away]\nold' },
      { role: 'user', content: '[Earlier in this run, summarized]\nolder' },
      { role: 'user', content: 'a real question' },
    ]);
    expect(out).toContain('a real question');
    expect(out).not.toContain('Historical context summary');
    expect(out).not.toContain('Earlier in this run');
  });
});
