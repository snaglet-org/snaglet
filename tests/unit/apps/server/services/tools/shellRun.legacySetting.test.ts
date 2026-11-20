import { describe, expect, it, jest, beforeEach } from '@jest/globals';

// The system-wide `shell_exec` setting (timeoutMs / maxBufferKb) carries over
// to shell(op:run) when a user has set it, and is ignored otherwise.
const readOptional = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('@server/services/settings', () => ({
  settingsService: { readOptional: (...args: unknown[]) => readOptional(...args) },
}));

import shellRun from '@server/services/ToolService/tools/shell/shellRun';

const node = `"${process.execPath}"`;

describe('shell(op:run) honors the legacy shell_exec setting', () => {
  beforeEach(() => readOptional.mockReset());

  it('uses session defaults when the setting is unset', async () => {
    readOptional.mockResolvedValue(null);
    const out = String(
      await shellRun(
        { cmd: `${node} -e "console.log('x'.repeat(3000))"`, yield_time_ms: 30_000 },
        {}
      )
    );
    expect(out).toContain('Process exited with code 0');
    expect(out).not.toContain('maxBufferKb');
  });

  it('caps output at maxBufferKb when set', async () => {
    readOptional.mockResolvedValue({ timeoutMs: 30_000, maxBufferKb: 1 });
    const out = String(await shellRun({ cmd: `${node} -e "console.log('x'.repeat(3000))"` }, {}));
    expect(out).toContain('[output truncated at the shell_exec maxBufferKb setting]');
  });

  it('bounds the blocking wait and process lifetime by timeoutMs when set', async () => {
    readOptional.mockResolvedValue({ timeoutMs: 1_000, maxBufferKb: 2048 });
    const t0 = Date.now();
    const out = String(await shellRun({ cmd: `${node} -e "setTimeout(()=>{}, 20000)"` }, {}));
    expect(Date.now() - t0).toBeLessThan(10_000);
    // Hard limit = timeoutMs, so the process is killed rather than left running.
    expect(out).toMatch(/KILLED|session ID/);
  });

  it('an explicit timeout_ms beats the setting', async () => {
    readOptional.mockResolvedValue({ timeoutMs: 1_000, maxBufferKb: 2048 });
    const out = String(
      await shellRun(
        {
          cmd: `${node} -e "setTimeout(()=>console.log('done'), 1500)"`,
          timeout_ms: 20_000,
          yield_time_ms: 15_000,
        },
        {}
      )
    );
    expect(out).toContain('done');
    expect(out).toContain('Process exited with code 0');
  });
});
