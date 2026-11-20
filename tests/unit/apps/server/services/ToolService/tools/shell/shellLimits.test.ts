/**
 * Shell lifetimes: env defaults, the `tool.shell` setting winning key by
 * key, the 4 h ceiling, the executor guard that must never cut a shell wait
 * the handler allows, and the shell schema saying the default and maximum
 * while staying small.
 */
import { describe, expect, it } from '@jest/globals';
import { toolSettings } from '@server/services/settings/categories/tool';
import { normalizeAnthropicInputSchema } from '@server/services/ToolService/ToolFormatService';
import {
  SHELL_CALL_GUARD_MS,
  TOOL_HARD_TIMEOUT_MS,
  resolveToolTimeoutMs,
} from '@server/services/ToolService/lib/executionGuards';
import shell from '@server/services/ToolService/tools/shell/shell/definition';
import {
  SHELL_TIMEOUT_CEILING_MS,
  clampShellTimeoutMs,
  formatShellDuration,
  resolveShellLimits,
} from '@server/services/ToolService/tools/shell/shellGuardrails';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('resolveShellLimits', () => {
  it('uses the env defaults when the setting is unset: 5 min, max 30 min, background 2 h', () => {
    expect(resolveShellLimits(null)).toEqual({
      defaultTimeoutMs: 5 * MIN,
      maxTimeoutMs: 30 * MIN,
      backgroundMaxMs: 2 * HOUR,
    });
  });

  it('lets each setting key win on its own, up to the 4 h ceiling', () => {
    expect(resolveShellLimits({ maxTimeoutMs: 4 * HOUR })).toEqual({
      defaultTimeoutMs: 5 * MIN,
      maxTimeoutMs: 4 * HOUR,
      backgroundMaxMs: 2 * HOUR,
    });
    expect(resolveShellLimits({ backgroundMaxMs: 3 * HOUR }).backgroundMaxMs).toBe(3 * HOUR);
    expect(resolveShellLimits({ maxTimeoutMs: 99 * HOUR }).maxTimeoutMs).toBe(
      SHELL_TIMEOUT_CEILING_MS
    );
  });

  it('never lets the default exceed the maximum', () => {
    expect(resolveShellLimits({ timeoutMs: 2 * HOUR })).toMatchObject({
      defaultTimeoutMs: 30 * MIN,
      maxTimeoutMs: 30 * MIN,
    });
    expect(resolveShellLimits({ timeoutMs: 20_000 }).defaultTimeoutMs).toBe(20_000);
  });
});

describe('clampShellTimeoutMs', () => {
  it('clamps a per-call value to [1 s, max] and falls back on garbage', () => {
    expect(clampShellTimeoutMs(2 * HOUR, 5 * MIN, 30 * MIN)).toBe(30 * MIN);
    expect(clampShellTimeoutMs(2 * HOUR, 5 * MIN, 4 * HOUR)).toBe(2 * HOUR);
    expect(clampShellTimeoutMs(10, 5 * MIN, 30 * MIN)).toBe(1_000);
    expect(clampShellTimeoutMs(undefined, 5 * MIN, 30 * MIN)).toBe(5 * MIN);
    expect(clampShellTimeoutMs('soon', 5 * MIN, 30 * MIN)).toBe(5 * MIN);
  });
});

describe('formatShellDuration', () => {
  it('reads as the model would write it', () => {
    expect(formatShellDuration(2 * HOUR)).toBe('2 h');
    expect(formatShellDuration(90 * MIN)).toBe('1 h 30 min');
    expect(formatShellDuration(45_000)).toBe('45 s');
    expect(formatShellDuration(0)).toBe('0 s');
  });
});

describe('the tool.shell setting schema', () => {
  const schema = toolSettings.shell.schema;

  it('takes any key alone, so raising the maximum does not opt into legacy timeoutMs', () => {
    expect(schema.safeParse({ maxTimeoutMs: 4 * HOUR }).success).toBe(true);
    expect(schema.safeParse({ backgroundMaxMs: HOUR }).success).toBe(true);
    expect(schema.safeParse({ timeoutMs: 10_000, maxBufferKb: 2048 }).success).toBe(true);
  });

  it('refuses a new limit over 4 h; keeps reading an older timeoutMs of any size', () => {
    expect(schema.safeParse({ maxTimeoutMs: 5 * HOUR }).success).toBe(false);
    expect(schema.safeParse({ backgroundMaxMs: 5 * HOUR }).success).toBe(false);
    expect(schema.safeParse({ timeoutMs: 5 * HOUR }).success).toBe(true);
  });
});

describe('executor guard for the shell family', () => {
  it('sits above the 4 h ceiling, so the session lifetime is always the real limit', () => {
    expect(SHELL_CALL_GUARD_MS).toBeGreaterThan(SHELL_TIMEOUT_CEILING_MS);
  });

  it('ignores a shell call timeout_ms (a process lifetime, not a call duration)', () => {
    for (const name of ['shell', 'exec_command', 'write_stdin', 'shell_exec']) {
      expect(resolveToolTimeoutMs(name, {}, {})).toBe(SHELL_CALL_GUARD_MS);
      expect(resolveToolTimeoutMs(name, { timeout_ms: 2 * HOUR }, {})).toBe(SHELL_CALL_GUARD_MS);
    }
    // An operator's per-tool setting still wins.
    expect(resolveToolTimeoutMs('shell', {}, { timeout_ms: 90_000 })).toBe(90_000);
    // Every other tool keeps the generic rules.
    expect(resolveToolTimeoutMs('any_tool', { timeout_ms: 2 * HOUR }, {})).toBe(30 * MIN);
    expect(resolveToolTimeoutMs('any_tool', {}, {})).toBe(TOOL_HARD_TIMEOUT_MS);
  });
});

/**
 * UTF-8 bytes of the Anthropic `tools` entry. `shell` is core, so every byte
 * is paid on every turn; the ceiling sits a few bytes over the measured size
 * so growth is a deliberate, reviewed edit. Before background jobs: 1,338.
 */
const SHELL_WIRE_BYTE_CEILING = 1_575; // background (+217) and the limits in timeout_ms: measured 1,555

function wireBytes(): number {
  return Buffer.byteLength(
    JSON.stringify({
      type: 'custom',
      name: shell.id,
      description: shell.description,
      input_schema: normalizeAnthropicInputSchema(shell.parameters_schema),
    }),
    'utf8'
  );
}

describe('shell definition', () => {
  const props = shell.parameters_schema.properties as Record<string, { description?: string }>;

  it('tells the model the default and maximum, and when to use background', () => {
    expect(props.timeout_ms?.description).toContain('Default 5 min, max 30 min');
    expect(props.timeout_ms?.description).toContain('background: default and max 2 h');
    expect(props.background?.description).toMatch(/tests, builds, servers/);
    expect(shell.description).toContain('background: true returns at once');
  });

  it('stays under its per-turn byte ceiling', () => {
    expect(wireBytes()).toBeLessThanOrEqual(SHELL_WIRE_BYTE_CEILING);
  });
});
