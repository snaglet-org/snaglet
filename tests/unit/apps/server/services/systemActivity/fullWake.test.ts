/**
 * The full-wake check (a person may be at the computer, not a Power Nap dark
 * wake), with fake commands: on macOS `pmset -g systemstate` decides by the
 * Graphics capability; when it can't be read, a keyboard or mouse touch in
 * the last 5 minutes (`ioreg` HIDIdleTime) does; when neither can be read
 * (one warning) and on other platforms, it counts as awake.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { logger } from '@server/config/logger';
import {
  createFullWakeCheck,
  parseHidIdleMs,
  parseSystemStateGraphics,
} from '@server/services/systemActivity/fullWake';

const FULL =
  'Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4\n';
const DARK = 'Current System Capabilities are: CPU Network \nCurrent Power State: 4\n';
const hid = (minutes: number) =>
  `+-o IOHIDSystem  <class IOHIDSystem>\n    {\n      "HIDIdleTime" = ${minutes * 60 * 1_000_000_000}\n    }\n`;

/** A fake command runner: pmset and ioreg answer (or throw) as given. */
function runner(answers: { pmset?: string | Error; ioreg?: string | Error }) {
  return jest.fn(async (file: string) => {
    const answer = file.endsWith('pmset') ? answers.pmset : answers.ioreg;
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error('not found');
    return answer;
  });
}

describe('parsing', () => {
  it('reads the Graphics capability and the HID idle time', () => {
    expect(parseSystemStateGraphics(FULL)).toBe(true);
    expect(parseSystemStateGraphics(DARK)).toBe(false);
    expect(parseSystemStateGraphics('pmset: unknown option')).toBeNull();
    expect(parseHidIdleMs(hid(2))).toBe(120_000);
    expect(parseHidIdleMs('nothing here')).toBeNull();
  });
});

describe('createFullWakeCheck', () => {
  it('says a Power Nap dark wake (no Graphics) is not a full wake', async () => {
    const run = runner({ pmset: DARK, ioreg: hid(0) });
    expect(await createFullWakeCheck({ platform: 'darwin', run })()).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('says a full wake (Graphics) is one', async () => {
    expect(await createFullWakeCheck({ platform: 'darwin', run: runner({ pmset: FULL }) })()).toBe(
      true
    );
  });

  it('falls back to a recent keyboard or mouse touch when pmset cannot be read', async () => {
    const away = createFullWakeCheck({
      platform: 'darwin',
      run: runner({ pmset: new Error('pmset failed'), ioreg: hid(10) }),
    });
    expect(await away()).toBe(false);
    const here = createFullWakeCheck({
      platform: 'darwin',
      run: runner({ pmset: 'no capabilities line', ioreg: hid(1) }),
    });
    expect(await here()).toBe(true);
  });

  it('counts as awake when neither can be read (warning once), and on other platforms', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const unreadable = createFullWakeCheck({ platform: 'darwin', run: runner({}) });
    expect(await unreadable()).toBe(true);
    expect(await unreadable()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('neither pmset nor ioreg'));
    warn.mockRestore();
    const run = runner({ pmset: DARK });
    expect(await createFullWakeCheck({ platform: 'linux', run })()).toBe(true);
    expect(await createFullWakeCheck({ platform: 'win32', run })()).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
