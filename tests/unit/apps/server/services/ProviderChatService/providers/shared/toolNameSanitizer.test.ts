import { createToolNameSanitizer } from '@server/services/ProviderChatService/providers/shared/toolNameSanitizer';
import {
  isValidToolName,
  NO_DOTS_TOOL_NAME_GRAMMAR,
} from '@server/services/ToolService/lib/toolName';

describe('createToolNameSanitizer', () => {
  it('round-trips a sanitized name back to the original', () => {
    const s = createToolNameSanitizer();
    const wire = s.sanitize('mcp__notion__search:pages');
    expect(isValidToolName(wire)).toBe(true);
    expect(wire).not.toContain(':');
    expect(s.resolve(wire)).toBe('mcp__notion__search:pages');
  });

  it('is idempotent per original (memoized)', () => {
    const s = createToolNameSanitizer();
    expect(s.sanitize('Send Message')).toBe(s.sanitize('Send Message'));
  });

  it('disambiguates colliding originals with a deterministic _2 suffix', () => {
    const s = createToolNameSanitizer();
    const first = s.sanitize('do thing'); // -> do_thing
    const second = s.sanitize('do:thing'); // also -> do_thing, must differ
    expect(first).toBe('do_thing');
    expect(second).toBe('do_thing_2');
    expect(first).not.toBe(second);
    // Both directions stay unambiguous.
    expect(s.resolve(first)).toBe('do thing');
    expect(s.resolve(second)).toBe('do:thing');
  });

  it('lets an already-legal name keep the un-suffixed slot', () => {
    const s = createToolNameSanitizer();
    const canonical = s.sanitize('mcp__a__b');
    const stale = s.sanitize('mcp__a__b'); // same original -> same wire name
    expect(canonical).toBe('mcp__a__b');
    expect(stale).toBe('mcp__a__b');
  });

  it('resolve() is identity for an unknown wire name', () => {
    const s = createToolNameSanitizer();
    expect(s.resolve('never_seen')).toBe('never_seen');
  });

  describe('no-dots grammar (Responses wire)', () => {
    it('coerces a dotted id and round-trips it back', () => {
      const s = createToolNameSanitizer(NO_DOTS_TOOL_NAME_GRAMMAR);
      const wire = s.sanitize('get.time');
      expect(wire).toBe('get_time');
      expect(isValidToolName(wire, NO_DOTS_TOOL_NAME_GRAMMAR)).toBe(true);
      expect(s.resolve(wire)).toBe('get.time');
    });

    it('disambiguates a dotted id that collides with a snake_case id', () => {
      const s = createToolNameSanitizer(NO_DOTS_TOOL_NAME_GRAMMAR);
      const canonical = s.sanitize('get_time'); // seeded first → un-suffixed
      const dotted = s.sanitize('get.time'); // also -> get_time, must differ
      expect(canonical).toBe('get_time');
      expect(dotted).toBe('get_time_2');
      expect(s.resolve(canonical)).toBe('get_time');
      expect(s.resolve(dotted)).toBe('get.time');
    });
  });
});
