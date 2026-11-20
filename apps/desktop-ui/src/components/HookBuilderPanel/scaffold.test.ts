import { describe, expect, it } from 'vitest';
import {
  HOOK_EVENT_NAMES,
  HOOK_TRIGGER_LABELS,
  scaffoldHookTs,
  validateHookName,
} from './scaffold';

describe('hook code scaffold', () => {
  it('uses the SDK event registry', () => {
    expect(HOOK_EVENT_NAMES).toContain('schedule:fire');
    expect(HOOK_EVENT_NAMES).toContain('message:create');
  });

  it('generates code-first lifecycle and schedule examples', () => {
    const code = scaffoldHookTs('daily-report', ['message:create']);
    expect(code).toContain("on: 'message:create'");
    expect(code).toContain("{ every: 15, unit: 'minute' }");
    expect(code).toContain('async run(event)');
  });

  it('labels the occurrence trigger and starts its template on done occurrences', () => {
    expect(HOOK_EVENT_NAMES).toContain('table_entry:occurrence');
    expect(HOOK_TRIGGER_LABELS['table_entry:occurrence']).toBe('Repeating row occurrence');
    const code = scaffoldHookTs('plants-done', ['table_entry:occurrence']);
    expect(code).toContain("on: 'table_entry:occurrence'");
    expect(code).toContain('  filter: {"action":"done"},\n');
    // A filter given wins; other triggers start without one.
    expect(scaffoldHookTs('x', ['table_entry:occurrence'], '{"action":"skipped"}')).toContain(
      'filter: {"action":"skipped"},'
    );
    expect(scaffoldHookTs('x', ['table_entry:update'])).not.toContain('filter:');
  });

  it('validates only the required workspace folder id', () => {
    expect(validateHookName('daily-report')).toBeNull();
    expect(validateHookName('')).toBe('Name is required.');
    expect(validateHookName('a'.repeat(65))).toBe('Name must be 64 characters or fewer.');
    expect(validateHookName('1-report')).toBe('Name must start with a letter.');
    expect(validateHookName('not valid')).toBe(
      'Name must contain only letters, numbers, "-", or "_".'
    );
  });
});
