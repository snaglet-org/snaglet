import { parseToolInputJson } from '@server/services/ProviderChatService/shared';

describe('parseToolInputJson', () => {
  it('returns {} for empty or whitespace-only input', () => {
    expect(parseToolInputJson('')).toEqual({});
    expect(parseToolInputJson('   ')).toEqual({});
    // @ts-expect-error - tolerate null/undefined at runtime
    expect(parseToolInputJson(undefined)).toEqual({});
  });

  it('parses a simple object payload', () => {
    expect(parseToolInputJson('{"path":"/a"}')).toEqual({ path: '/a' });
  });

  it('preserves a shell command with &&, $VAR, and = (the reported drop shape)', () => {
    // This payload class must not fall back to a silent {} downstream
    // ("command is required").
    const cmd = 'cd /repo && F=apps/server/src/x.ts && grep -n "foo" $F';
    const raw = JSON.stringify({ tool: 'shell_exec', command: cmd });
    expect(parseToolInputJson(raw)).toEqual({ tool: 'shell_exec', command: cmd });
  });

  it('preserves a large escaped file content payload (1KB+)', () => {
    const content = 'line with "quotes" and \\backslashes\\ and \n newlines\n'.repeat(40);
    const raw = JSON.stringify({ path: '/big.ts', content });
    const parsed = parseToolInputJson(raw);
    expect(parsed.path).toBe('/big.ts');
    expect(parsed.content).toBe(content);
    expect((parsed.content as string).length).toBeGreaterThan(1000);
  });

  it('scrubs a lone surrogate inside a string value and still parses', () => {
    // A lone high surrogate (U+D800) embedded in an otherwise valid JSON string.
    const raw = '{"command":"echo \uD800 probe"}';
    const parsed = parseToolInputJson(raw);
    expect(typeof parsed.command).toBe('string');
    // The lone surrogate is replaced with U+FFFD, parse succeeds, param survives.
    expect(parsed.command).toContain('echo');
    expect(parsed.command).toContain('probe');
  });

  it('throws a diagnostic error on genuinely malformed JSON instead of silently dropping params', () => {
    expect(() => parseToolInputJson('{"command": "unterminated')).toThrow(
      /Failed to parse streamed tool-input JSON/
    );
  });

  it('returns {} for a non-object top-level value rather than crashing', () => {
    expect(parseToolInputJson('"just a string"')).toEqual({});
    expect(parseToolInputJson('[1,2,3]')).toEqual({});
    expect(parseToolInputJson('42')).toEqual({});
  });
});
