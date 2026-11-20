import { describe, expect, it, afterEach } from '@jest/globals';
import {
  resolveGitUserEmail,
  setGitEmailReaderForTests,
} from '@server/services/ToolService/lib/gitUserEmail';

describe('resolveGitUserEmail', () => {
  afterEach(() => setGitEmailReaderForTests(null));

  it('prefers the global email', () => {
    setGitEmailReaderForTests((scope) =>
      scope === 'global' ? 'user@example.com\n' : 'local@example.com'
    );
    expect(resolveGitUserEmail('/tmp/x')).toBe('user@example.com');
  });

  it('falls back to the working directory config', () => {
    setGitEmailReaderForTests((scope) => (scope === 'local' ? 'local@example.com' : ''));
    expect(resolveGitUserEmail('/tmp/x')).toBe('local@example.com');
  });

  it('returns null when unset or malformed, and caches the read', () => {
    let calls = 0;
    setGitEmailReaderForTests(() => {
      calls += 1;
      return 'not an email <x>';
    });
    expect(resolveGitUserEmail('/tmp/x')).toBeNull();
    expect(resolveGitUserEmail('/tmp/x')).toBeNull();
    expect(calls).toBe(2); // global + local once, second call cached
  });
});
