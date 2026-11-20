/**
 * Process-spawning tools pass caller text as argv entries to execFile —
 * never through a shell — and anchor it so it cannot be read as a flag.
 * Each case feeds the payload a prompt-injected agent would use and asserts
 * it reaches the child process as one inert argument.
 */

const execFileMock = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import checkAvailability from '@server/services/ToolService/handlers/integrations/imessage/checkAvailability';
import sendMessage from '@server/services/ToolService/handlers/integrations/imessage/sendMessage';
import searchMessages from '@server/services/ToolService/handlers/integrations/imessage/searchMessages';
import codeSearch from '@server/services/ToolService/handlers/search/codeSearch';
import {
  buildOsascriptArgs,
  buildSqliteArgs,
} from '@server/services/ToolService/handlers/integrations/imessage/runners';

type Callback = (err: Error | null, value?: { stdout: string; stderr: string }) => void;

const SHELL_PAYLOAD = 'hi"; touch /tmp/snaglet-pwned; echo "$(id)`id`';

function lastCall(): { file: string; args: string[]; opts: Record<string, unknown> } {
  const call = execFileMock.mock.calls[execFileMock.mock.calls.length - 1] as unknown[];
  return {
    file: call[0] as string,
    args: call[1] as string[],
    opts: (typeof call[2] === 'object' && call[2] !== null ? call[2] : {}) as Record<
      string,
      unknown
    >,
  };
}

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as Callback;
    cb(null, { stdout: '', stderr: '' });
  });
});

describe('imessage', () => {
  it('passes the recipient and body as osascript argv, not AppleScript or shell source', async () => {
    const body = 'x"\nAPPLESCRIPT\ntouch /tmp/snaglet-pwned\n" & (do shell script "id") & "';
    await sendMessage({ to: '-s', body }, {});
    const { file, args } = lastCall();
    expect(file).toBe('osascript');
    const separator = args.indexOf('--');
    expect(separator).toBeGreaterThan(0);
    expect(args.slice(separator + 1)).toEqual(['-s', body, 'iMessage']);
    const scriptSource = args.slice(0, separator).join('\n');
    expect(scriptSource).not.toContain('touch');
    expect(scriptSource).not.toContain('do shell script');
  });

  it('checks availability with the contact as an argv value', async () => {
    await checkAvailability({ contact: 'a"b' }, {});
    const { args } = lastCall();
    expect(args[args.length - 1]).toBe('a"b');
    expect(args[args.length - 2]).toBe('--');
  });

  it('runs sqlite3 read-only with the SQL as one argv entry and quotes doubled', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      (args[args.length - 1] as Callback)(null, { stdout: '[]', stderr: '' });
    });
    await searchMessages({ query: `it's "$(id)"` }, {});
    const { file, args } = lastCall();
    expect(file.split('/').pop()).toBe('sqlite3');
    expect(args.slice(0, 5)).toEqual(['-init', '/dev/null', '-safe', '-readonly', '-json']);
    expect(args).toHaveLength(7);
    expect(args[6]).toMatch(/^SELECT /);
    expect(args[6]).toContain(`LIKE '%it''s "$(id)"%'`);
  });

  it('builds argv helpers deterministically', () => {
    expect(buildOsascriptArgs(['on run argv', 'end run'], ['a'])).toEqual([
      '-e',
      'on run argv',
      '-e',
      'end run',
      '--',
      'a',
    ]);
    expect(buildSqliteArgs('/db', 'SELECT 1;')).toEqual([
      '-init',
      '/dev/null',
      '-safe',
      '-readonly',
      '-json',
      '/db',
      'SELECT 1;',
    ]);
  });
});

describe('code search (ripgrep)', () => {
  it('ranks exact and prefix collisions before substrings with deterministic path ties', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      (args[args.length - 1] as Callback)(null, {
        stdout: [
          '/repo/z/refreshToken.ts',
          '/repo/a/oldRefreshToken.ts',
          '/repo/b/refreshTokenCache.ts',
          '/repo/a/refreshToken.ts',
        ].join('\n'),
        stderr: '',
      });
    });
    const output = JSON.parse(
      await codeSearch({ query: 'refreshToken', mode: 'name', path: '/repo', max_results: 3 }, {})
    );
    expect(output.files.map((hit: { path: string }) => hit.path)).toEqual([
      'a/refreshToken.ts',
      'z/refreshToken.ts',
      'b/refreshTokenCache.ts',
    ]);
  });

  it('compacts name hits without repeating the root or path evidence', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      (args[args.length - 1] as Callback)(null, {
        stdout: '/work/project/src/a.ts\n/work/project/src/b.ts\n',
        stderr: '',
      });
    });
    const raw = await codeSearch(
      { query: '.ts', path: '/work/project', mode: 'both', max_results: 2 },
      {}
    );
    expect(JSON.parse(raw as string)).toEqual({
      basePath: '/work/project',
      files: [
        { path: 'src/a.ts', line: null },
        { path: 'src/b.ts', line: null },
      ],
    });
    expect(raw).not.toContain('\n');
  });

  it('preserves content lines, escaping and order in compact rooted results', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      (args[args.length - 1] as Callback)(null, {
        stdout: [
          {
            type: 'match',
            data: {
              path: { text: '/work/project/src/b.ts' },
              line_number: 7,
              lines: { text: 'const b = "quoted";\n' },
            },
          },
          {
            type: 'match',
            data: { path: { text: '/other/a.ts' }, line_number: 2, lines: { text: 'outside\n' } },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n'),
        stderr: '',
      });
    });
    const raw = await codeSearch({ query: 'x', path: '/work/project', mode: 'content' }, {});
    expect(JSON.parse(raw as string)).toEqual({
      basePath: '/work/project',
      files: [
        { path: 'src/b.ts', line: 7, snippet: 'const b = "quoted";' },
        { path: '/other/a.ts', line: 2, snippet: 'outside' },
      ],
    });
  });

  it('roots omitted-path output at the context cwd', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      (args[args.length - 1] as Callback)(null, { stdout: '/context/src/a.ts\n', stderr: '' });
    });
    const raw = await codeSearch({ query: '.ts', mode: 'name' }, {}, { cwd: '/context' });
    expect(JSON.parse(raw as string)).toEqual({
      basePath: '/context',
      files: [{ path: 'src/a.ts', line: null }],
    });
  });

  it('binds a dash-leading query with -e and ends options before the path', async () => {
    await codeSearch({ query: '--pre=/bin/sh', path: '/work/project', mode: 'content' }, {});
    const { file, args } = lastCall();
    expect(file).toBe('rg');
    const patternIndex = args.indexOf('-e');
    expect(args[patternIndex + 1]).toBe('--pre=/bin/sh');
    expect(args.slice(-2)).toEqual(['--', '/work/project']);
  });

  it('ends options before the path in file-name mode', async () => {
    await codeSearch({ query: 'x', path: '/work/project', mode: 'name' }, {});
    expect(lastCall().args).toEqual(['--no-config', '--files', '--', '/work/project']);
  });
});
