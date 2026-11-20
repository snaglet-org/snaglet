import { describe, expect, it } from '@jest/globals';
import { extractMarkedPath, mergePaths } from '@server/services/ToolService/lib/loginShellPath';

describe('loginShellPath', () => {
  it('puts login-shell entries first and keeps inherited ones it lacks, without duplicates', () => {
    expect(mergePaths('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin:/usr/sbin:/sbin')).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    );
  });

  it('ignores empty entries and a missing inherited PATH', () => {
    expect(mergePaths('/a::/b', undefined)).toBe('/a:/b');
  });

  it('drops relative entries from both PATHs, so a tool folder cannot shadow a command', () => {
    expect(mergePaths('.:/a/bin:node_modules/.bin', 'bin:/usr/bin:./scripts')).toBe(
      '/a/bin:/usr/bin'
    );
  });

  it('extracts the PATH printed between markers from noisy startup output', () => {
    const noisy =
      'Welcome!\nnvm loaded\n__SNAGLET_LOGIN_PATH__/x/bin:/usr/bin__SNAGLET_LOGIN_PATH__\ntrailing';
    expect(extractMarkedPath(noisy)).toBe('/x/bin:/usr/bin');
  });

  it('returns null when the markers are missing or empty', () => {
    expect(extractMarkedPath('no markers here')).toBeNull();
    expect(extractMarkedPath('__SNAGLET_LOGIN_PATH____SNAGLET_LOGIN_PATH__')).toBeNull();
  });
});
