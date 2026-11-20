import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type Row = { name: string; enabled: boolean; buildStatus: string; lastError: string | null };
let row: Row | null;
const findByName = jest.fn(async () => row);
const setEnabled = jest.fn(async (_name: string, enabled: boolean) => {
  if (row) row = { ...row, enabled };
  return row;
});
const registerHookFolder = jest.fn(async () => undefined);
const updateFiles = jest.fn(async () => ({}));
const emit = jest.fn();

jest.mock('@snaglet/db/tables/hook_registrations', () => ({ HookRegistrations: { findByName } }));
jest.mock('@server/services/customHooks/HookRegistryService', () => ({
  getHookRegistry: () => ({ setEnabled, registerHookFolder }),
}));
jest.mock('@server/services/customHooks/HookWorkspaceService', () => ({
  hookWorkspaceService: { updateFiles },
}));
jest.mock('@server/realtime/surfaces/hookRuns', () => ({ emitHookEnabledChanged: emit }));

import {
  disableHook,
  enableHook,
  updateHook,
} from '@server/services/ToolService/handlers/hooks/hook-manage';

const parse = (out: unknown) => JSON.parse(out as string);

beforeEach(() => {
  jest.clearAllMocks();
  row = { name: 'a-hook', enabled: false, buildStatus: 'ready', lastError: null };
});

describe('hook enable/disable/update', () => {
  it('enable flips state once and is idempotent', async () => {
    expect(parse(await enableHook({ name: 'a-hook' }, {}, undefined))).toMatchObject({
      enabled: true,
      changed: true,
    });
    expect(parse(await enableHook({ name: 'a-hook' }, {}, undefined))).toMatchObject({
      enabled: true,
      changed: false,
    });
    expect(setEnabled).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('disable is idempotent and touches neither code nor execution', async () => {
    expect(parse(await disableHook({ name: 'a-hook' }, {}, undefined))).toMatchObject({
      enabled: false,
      changed: false,
    });
    expect(setEnabled).not.toHaveBeenCalled();
    expect(updateFiles).not.toHaveBeenCalled();
  });

  it('refuses unknown hooks and missing names', async () => {
    row = null;
    await expect(enableHook({ name: 'a-hook' }, {}, undefined)).rejects.toThrow('not registered');
    await expect(enableHook({}, {}, undefined)).rejects.toThrow('name is required');
  });

  it('update writes hook.ts, rebuilds, and leaves enabled state unchanged', async () => {
    row = { ...row!, enabled: true };
    const out = parse(await updateHook({ name: 'a-hook', hook_source: 'src' }, {}, undefined));
    expect(updateFiles).toHaveBeenCalledWith('a-hook', { 'hook.ts': 'src' });
    expect(registerHookFolder).toHaveBeenCalledWith('a-hook');
    expect(out).toMatchObject({ updated: true, enabled: true, enabled_unchanged: true });
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('update reports build failures and validates input', async () => {
    findByName.mockResolvedValueOnce(row).mockResolvedValueOnce({
      ...row!,
      buildStatus: 'failed',
      lastError: 'TS2304',
    });
    await expect(updateHook({ name: 'a-hook', hook_source: 'bad' }, {}, undefined)).rejects.toThrow(
      'TS2304'
    );
    await expect(updateHook({ name: 'a-hook' }, {}, undefined)).rejects.toThrow('hook_source');
  });
});
