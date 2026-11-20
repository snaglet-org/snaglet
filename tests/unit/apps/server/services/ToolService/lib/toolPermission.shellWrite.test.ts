/**
 * shell(op:write) is guarded line by line: every line it would
 * submit (the session's unfinished line + chars) is a target for the same
 * shell(…) allow/deny rules as op:run.
 */
import os from 'os';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { evaluateToolPermission } from '@server/services/ToolService/lib/toolPermission';
import {
  startShellSession,
  writeShellSession,
  getShellSessionPendingLine,
  killShellSessionsForThread,
  waitForShellSessionClose,
} from '@server/services/ToolService/tools/shell/codex-shell-sessions';
import { stdinCommandLines } from '@server/services/ToolService/tools/shell/stdinLines';
import { gitRefusalForStdin } from '@server/services/ToolService/tools/shell/gitSafety';

const THREAD = `unit-shellwrite-${process.pid}`;
const access = (p: Partial<ToolAccessConfig>): ToolAccessConfig => ({
  mode: 'all',
  allowList: [],
  denyList: [],
  ...p,
});
const write = (chars: string, session_id = 999_999) => ({ op: 'write', session_id, chars });
const verdict = (a: ToolAccessConfig, tool: string, input: Record<string, unknown>) =>
  evaluateToolPermission(a, tool, input);

function liveBash(): number {
  return startShellSession({ cmd: 'cat >/dev/null', cwd: os.tmpdir(), threadId: THREAD }).id;
}
/** Simulate a landed write the way shellWrite does. */
function land(id: number, chars: string): void {
  const { nextPending } = stdinCommandLines(getShellSessionPendingLine(id), chars);
  expect(writeShellSession(id, chars, nextPending)).toEqual({ ok: true });
}

afterAll(() => {
  killShellSessionsForThread(THREAD);
});

describe('stdinCommandLines', () => {
  it.each([
    ['', 'ls\n', ['ls'], ''],
    ['', 'echo a\r\necho b\rc\n', ['echo a', 'echo b', 'c'], ''],
    ['', '\n\n  \n', [], ''],
    ['', 'r\\\nm -rf x\n', ['rm -rf x'], ''],
    ['r', 'm -rf x\n', ['rm -rf x'], ''],
    ['', 'git sta', ['git sta'], 'git sta'],
    ['git sta', 'sh\n', ['git stash'], ''],
    ['r\\', '\nm -rf x\n', ['rm -rf x'], ''],
    ['', 'y', ['y'], 'y'],
  ])('pending %j + chars %j', (pending, chars, lines, nextPending) => {
    expect(stdinCommandLines(pending, chars)).toEqual({ lines, nextPending });
  });
});

describe('evaluateToolPermission — shell(op:write) deny rules', () => {
  const deny = access({ mode: 'deny_list', denyList: ['shell(rm:*)'] });

  it('denies a denied command typed into a session', () => {
    expect(verdict(deny, 'shell', write('rm -rf x\n')).decision).toBe('deny');
  });
  it('denies when one line of a multi-line write is denied', () => {
    expect(verdict(deny, 'shell', write('echo ok\nrm -rf x\necho after\n')).decision).toBe('deny');
  });
  it('denies across a `\\` continuation', () => {
    expect(verdict(deny, 'shell', write('r\\\nm -rf x\n')).decision).toBe('deny');
  });
  it('denies through the legacy write_stdin alias', () => {
    expect(verdict(deny, 'write_stdin', { session_id: 1, chars: 'rm -rf x\n' }).decision).toBe(
      'deny'
    );
  });
  it('denies via the shell_exec(…) namespace too', () => {
    const legacy = access({ mode: 'deny_list', denyList: ['shell_exec(rm:*)'] });
    expect(verdict(legacy, 'shell', write('rm -rf x\n')).decision).toBe('deny');
  });
  it('checks a decoy `cmd` on write as well', () => {
    expect(verdict(deny, 'shell', { ...write('echo ok\n'), cmd: 'rm -rf x' }).decision).toBe(
      'deny'
    );
  });
  it('allows a line with no deny hit in deny_list mode', () => {
    expect(verdict(deny, 'shell', write('echo ok\n')).decision).toBe('allow');
  });
  it('allows an empty poll', () => {
    expect(verdict(deny, 'shell', write('')).decision).toBe('allow');
  });

  it('denies a command split across two writes (pending line from the session)', () => {
    const id = liveBash();
    expect(verdict(deny, 'shell', write('r', id)).decision).toBe('allow');
    land(id, 'r');
    expect(getShellSessionPendingLine(id)).toBe('r');
    expect(verdict(deny, 'shell', write('m -rf x\n', id)).decision).toBe('deny');
    // A bare newline submits the pending line, so it is checked too.
    land(id, 'm -rf x');
    expect(verdict(deny, 'shell', write('\n', id)).decision).toBe('deny');
  });
});

describe('evaluateToolPermission — shell(op:write) in allow_list mode', () => {
  const allowBashOnly = access({ mode: 'allow_list', allowList: ['shell(bash)'] });

  it('asks for a line no allow rule covers, same as run', () => {
    const v = verdict(allowBashOnly, 'shell', write('ls\n'));
    expect(v.decision).toBe('ask');
    expect(verdict(allowBashOnly, 'shell', { op: 'run', cmd: 'ls' }).decision).toBe('ask');
  });
  it('allows an empty poll', () => {
    expect(verdict(allowBashOnly, 'shell', write('')).decision).toBe('allow');
  });
  it('allows lines every one of which an allow rule covers; chaining still asks', () => {
    const a = access({ mode: 'allow_list', allowList: ['shell(git:*)'] });
    expect(verdict(a, 'shell', write('git status\ngit log\n')).decision).toBe('allow');
    expect(verdict(a, 'shell', write('git status && rm -rf x\n')).decision).toBe('ask');
  });

  it('a bare write_stdin allow means "trust stdin", but deny still wins', () => {
    const trust = access({
      mode: 'allow_list',
      allowList: ['shell(bash)', 'write_stdin'],
      denyList: ['shell(rm:*)'],
    });
    expect(verdict(trust, 'shell', write('python3 -c "print(1)"\n')).decision).toBe('allow');
    expect(verdict(trust, 'shell', write('rm -rf x\n')).decision).toBe('deny');
    // The op-scoped allow does not leak to run.
    expect(verdict(trust, 'shell', { op: 'run', cmd: 'ls' }).decision).toBe('ask');
  });
  it('a bare shell allow covers write too, and deny still wins', () => {
    const trust = access({ mode: 'allow_list', allowList: ['shell'], denyList: ['shell(rm:*)'] });
    expect(verdict(trust, 'shell', write('anything at all\n')).decision).toBe('allow');
    expect(verdict(trust, 'shell', write('rm -rf x\n')).decision).toBe('deny');
  });
});

describe('ask verdict carries the full joined lines (what the human approves)', () => {
  it('shows `rm -rf x`, not just the `m -rf x` in chars', () => {
    const id = liveBash();
    land(id, 'r');
    const v = verdict(
      access({ mode: 'allow_list', allowList: ['shell(bash)'] }),
      'shell',
      write('m -rf x\n', id)
    );
    expect(v.decision).toBe('ask');
    expect(v.submittedLines).toEqual(['rm -rf x']);
    expect(v.reason).toContain('rm -rf x');
  });
  it('run asks carry no submittedLines', () => {
    const v = verdict(access({ mode: 'allow_list', allowList: [] }), 'shell', {
      op: 'run',
      cmd: 'ls',
    });
    expect(v.decision).toBe('ask');
    expect(v.submittedLines).toBeUndefined();
  });
  it('known race (accepted): pending is read at verdict time; a later write can change what an approved ask submits', () => {
    const a = access({ mode: 'allow_list', allowList: ['shell(bash)'] });
    const id = liveBash();
    land(id, 'echo ');
    const v = verdict(a, 'shell', write('hi\n', id));
    expect(v.submittedLines).toEqual(['echo hi']);
    // Another write lands before the human approves: the same chars now submit
    // different text. The rail does not re-run the access check at write time.
    land(id, 'X');
    expect(stdinCommandLines(getShellSessionPendingLine(id), 'hi\n').lines).toEqual(['echo Xhi']);
  });
});

describe('pendingLine lifecycle', () => {
  it('is cleared when the session exits', async () => {
    const id = startShellSession({ cmd: 'sh', cwd: os.tmpdir(), threadId: THREAD }).id;
    land(id, 'echo pend');
    expect(getShellSessionPendingLine(id)).toBe('echo pend');
    land(id, '\nexit 0\n');
    await waitForShellSessionClose(id, 5_000);
    expect(getShellSessionPendingLine(id)).toBe('');
  });
  it('is cleared when the session is killed, and never carried to a new session', () => {
    const id = liveBash();
    land(id, 'rm -rf');
    expect(killShellSessionsForThread(THREAD)).toBeGreaterThan(0);
    expect(getShellSessionPendingLine(id)).toBe('');
    const next = liveBash();
    expect(next).not.toBe(id);
    expect(getShellSessionPendingLine(next)).toBe('');
  });
  it('is unchanged by a write that did not land', async () => {
    const id = liveBash();
    land(id, 'abc');
    killShellSessionsForThread(THREAD);
    expect(writeShellSession(id, 'def', 'abcdef').ok).toBe(false);
    expect(getShellSessionPendingLine(id)).toBe('');
  });
  it('unknown sessions read as empty', () => {
    expect(getShellSessionPendingLine(123_456_789)).toBe('');
  });
});

describe('git rail reads the same joined text', () => {
  it('refuses `git sta` + `sh\\n` split across writes', () => {
    expect(gitRefusalForStdin('git sta', '')).toBeNull();
    expect(gitRefusalForStdin('sh\n', 'git sta')).toMatch(/^Refused: /);
  });
  it('refuses across a `\\` continuation', () => {
    expect(gitRefusalForStdin('git \\\nstash\n', '')).toMatch(/^Refused: /);
  });
});

describe('cross-op command denies (deny-only, never widens)', () => {
  it('an exec_command(rm:*) deny also blocks rm typed via write', () => {
    const a = access({ mode: 'deny_list', denyList: ['exec_command(rm:*)'] });
    expect(verdict(a, 'shell', write('rm -rf x\n')).decision).toBe('deny');
  });
  it('a write_stdin(rm:*) deny also blocks rm via run', () => {
    const a = access({ mode: 'deny_list', denyList: ['write_stdin(rm:*)'] });
    expect(verdict(a, 'shell', { op: 'run', cmd: 'rm -rf x' }).decision).toBe('deny');
  });
  it('a bare op-scoped deny stays op-scoped (write_stdin deny does not block run)', () => {
    const a = access({ mode: 'deny_list', denyList: ['write_stdin'] });
    expect(verdict(a, 'shell', { op: 'run', cmd: 'ls' }).decision).toBe('allow');
    expect(verdict(a, 'shell', write('ls\n')).decision).toBe('deny');
  });
  it('a scoped shell_exec(git:*) allow does not cover write lines (allow stays op-scoped)', () => {
    const a = access({ mode: 'allow_list', allowList: ['shell_exec(bash)', 'shell_exec(git:*)'] });
    expect(verdict(a, 'shell', write('git status\n')).decision).toBe('ask');
  });
});
