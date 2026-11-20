/**
 * Whether the computer is fully awake, so a person may be at it, and not in a
 * macOS dark wake. With Power Nap a Mac with its lid closed wakes for half a
 * minute at a time, about once a minute; Node's timers run then, so a
 * first-open wake would otherwise fire into a closed laptop. On macOS
 * `pmset -g systemstate` lists the `Graphics` capability only in a full wake;
 * when that can't be read, a keyboard or mouse touch in the last
 * {@link HID_ACTIVE_MS} (`ioreg` HIDIdleTime) counts. Other platforms, and a
 * Mac where neither can be read, count as awake.
 */
import { execFile } from 'node:child_process';
import { logger } from '@server/config/logger';

/** Runs a command and resolves with its stdout. */
type RunCommand = (file: string, args: string[]) => Promise<string>;

/** A keyboard or mouse touch this recent counts as someone at the computer. */
const HID_ACTIVE_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 5_000;

/** `pmset -g systemstate`: whether the capabilities include Graphics; null when absent. */
export function parseSystemStateGraphics(output: string): boolean | null {
  const line = /Current System Capabilities are:(.*)/i.exec(output);
  return line ? /\bGraphics\b/.test(line[1] ?? '') : null;
}

/** `ioreg -c IOHIDSystem`: milliseconds since the last keyboard or mouse touch; null when absent. */
export function parseHidIdleMs(output: string): number | null {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(output);
  return match ? Number(match[1]) / 1_000_000 : null;
}

const runCommand: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout)))
    );
  });

/** @public A full-wake check for `platform`, reading through `run` (unit tests pass fakes). */
export function createFullWakeCheck(
  options: { platform?: NodeJS.Platform; run?: RunCommand } = {}
): () => Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  let warned = false;
  return async () => {
    if (platform !== 'darwin') return true;
    try {
      const graphics = parseSystemStateGraphics(await run('/usr/bin/pmset', ['-g', 'systemstate']));
      if (graphics !== null) return graphics;
    } catch {
      // Fall back to the last keyboard or mouse touch.
    }
    try {
      const idleMs = parseHidIdleMs(
        await run('/usr/sbin/ioreg', ['-r', '-c', 'IOHIDSystem', '-d', '1'])
      );
      if (idleMs !== null) return idleMs < HID_ACTIVE_MS;
    } catch {
      // Neither can be read: count it as awake (warned once below).
    }
    if (!warned) {
      warned = true;
      logger.warn(
        '[wake] neither pmset nor ioreg could be read; counting the computer as fully awake, so a Power Nap dark wake may run a first-open automation'
      );
    }
    return true;
  };
}

/** The scheduler's check (an object, so tests can stub it). */
export const systemAwake = { isFullWake: createFullWakeCheck() };
