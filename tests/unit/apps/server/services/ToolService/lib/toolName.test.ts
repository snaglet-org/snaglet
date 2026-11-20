import {
  TOOL_NAME_PATTERN,
  TOOL_NAME_MAX_LENGTH,
  NO_DOTS_TOOL_NAME_GRAMMAR,
  DOTTED_TOOL_NAME_GRAMMAR,
  isValidToolName,
  sanitizeToolNameSegment,
  assertValidToolId,
} from '@server/services/ToolService/lib/toolName';

describe('isValidToolName', () => {
  it('accepts snake_case, dotted, hyphenated, and MCP-style ids', () => {
    for (const name of [
      'file_read',
      'workspace.search',
      'thread-send',
      'mcp__notion__search',
      'gpt-4o',
    ]) {
      expect(isValidToolName(name)).toBe(true);
      expect(TOOL_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  it('rejects spaces, colons, the U+2192 arrow, and empty', () => {
    expect(isValidToolName('Send Message')).toBe(false);
    expect(isValidToolName('server:tool')).toBe(false);
    expect(isValidToolName('action→database_query')).toBe(false);
    expect(isValidToolName('')).toBe(false);
  });

  it('rejects names longer than the OpenAI cap', () => {
    expect(isValidToolName('a'.repeat(TOOL_NAME_MAX_LENGTH))).toBe(true);
    expect(isValidToolName('a'.repeat(TOOL_NAME_MAX_LENGTH + 1))).toBe(false);
  });
});

describe('sanitizeToolNameSegment', () => {
  it('passes an already-legal name through unchanged (keeps MCP `__`)', () => {
    expect(sanitizeToolNameSegment('mcp__server__tool')).toBe('mcp__server__tool');
    expect(sanitizeToolNameSegment('file_read')).toBe('file_read');
  });

  it('replaces the poison arrow so a replayed action call is legal', () => {
    const out = sanitizeToolNameSegment('action→database_query');
    expect(out).toBe('action_database_query');
    expect(isValidToolName(out)).toBe(true);
  });

  it('replaces spaces and colons and collapses repeated underscores', () => {
    expect(sanitizeToolNameSegment('Send Message To My Agent')).toBe('Send_Message_To_My_Agent');
    expect(sanitizeToolNameSegment('server:do:thing')).toBe('server_do_thing');
    expect(sanitizeToolNameSegment('a   b')).toBe('a_b');
  });

  it('is deterministic — same input always yields the same segment', () => {
    const a = sanitizeToolNameSegment('weird name!!');
    const b = sanitizeToolNameSegment('weird name!!');
    expect(a).toBe(b);
    expect(isValidToolName(a)).toBe(true);
  });

  it('caps output at the OpenAI length limit', () => {
    const out = sanitizeToolNameSegment('x '.repeat(100));
    expect(out.length).toBeLessThanOrEqual(TOOL_NAME_MAX_LENGTH);
    expect(isValidToolName(out)).toBe(true);
  });

  it('never returns an empty name', () => {
    expect(sanitizeToolNameSegment('   ')).toBe('_');
  });
});

describe('no-dots wire grammar (Responses: codex + copilot/responses)', () => {
  it('rejects a dotted name under the no-dots grammar but allows it under the default', () => {
    // `get.time` is legal on chat-completions but 400s on the Responses wire.
    expect(isValidToolName('get.time', DOTTED_TOOL_NAME_GRAMMAR)).toBe(true);
    expect(isValidToolName('get.time', NO_DOTS_TOOL_NAME_GRAMMAR)).toBe(false);
  });

  it('coerces dots to underscores under the no-dots grammar', () => {
    expect(sanitizeToolNameSegment('get.time', NO_DOTS_TOOL_NAME_GRAMMAR)).toBe('get_time');
    expect(
      isValidToolName(
        sanitizeToolNameSegment('get.time', NO_DOTS_TOOL_NAME_GRAMMAR),
        NO_DOTS_TOOL_NAME_GRAMMAR
      )
    ).toBe(true);
  });

  it('leaves dots untouched under the default (chat-completions) grammar', () => {
    expect(sanitizeToolNameSegment('get.time')).toBe('get.time');
    expect(sanitizeToolNameSegment('workspace.search')).toBe('workspace.search');
  });

  it('still passes clean snake_case / hyphen ids through both grammars', () => {
    expect(sanitizeToolNameSegment('file_read', NO_DOTS_TOOL_NAME_GRAMMAR)).toBe('file_read');
    expect(sanitizeToolNameSegment('mcp__notion__search', NO_DOTS_TOOL_NAME_GRAMMAR)).toBe(
      'mcp__notion__search'
    );
  });
});

describe('assertValidToolId', () => {
  it('is a no-op for a legal id', () => {
    expect(() => assertValidToolId('workspace_search')).not.toThrow();
  });

  it('throws for an id that would break OpenAI/Copilot', () => {
    expect(() => assertValidToolId('my tool')).toThrow(/Invalid tool id/);
    expect(() => assertValidToolId('a:b', 'tool folder "a:b"')).toThrow(/a:b/);
  });
});
