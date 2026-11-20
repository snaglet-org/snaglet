/**
 * `hook.registry_changed`: the registry tells lists (the Automations view)
 * when a script's build or registration changed, so a new or edited script
 * shows its build state and switch without a reload. One when a build starts,
 * one when the pass ends, whatever it ended in.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const emitHookRegistryChanged = jest.fn();
jest.mock('@server/realtime/surfaces/hookRuns', () => ({
  ...jest.requireActual<object>('@server/realtime/surfaces/hookRuns'),
  emitHookRegistryChanged: (...args: unknown[]) => emitHookRegistryChanged(...args),
}));
const buildHookBundle = jest.fn();
jest.mock('@server/services/customHooks/buildHookBundle', () => ({
  ...jest.requireActual<object>('@server/services/customHooks/buildHookBundle'),
  buildHookBundle: (...args: unknown[]) => buildHookBundle(...args),
}));
jest.mock('@server/services/settings/settingsService', () => ({
  settingsService: { read: async () => true },
}));

import { HookRegistrations, type HookRegistrationRow } from '@snaglet/db/tables/hook_registrations';
import { HookRegistryService } from '@server/services/customHooks/HookRegistryService';

const row = {
  id: 'hook_1',
  name: 'test-script',
  sourcePath: '/tmp/snaglet-test/hooks/test-script/hook.ts',
  enabled: false,
  runAsAgentId: null,
  runAsBuildHash: null,
  buildStatus: 'pending',
  sourceHash: null,
  buildHash: null,
  sdkHash: null,
  builtPath: null,
  lastError: null,
  lastBuiltAt: null,
  createdAt: '',
  updatedAt: '',
} as unknown as HookRegistrationRow;

let dir: string;
const states: string[] = [];

beforeEach(async () => {
  jest.clearAllMocks();
  states.length = 0;
  dir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-registry-changed-'));
  await mkdir(path.join(dir, 'test-script'));
  await writeFile(path.join(dir, 'test-script', 'hook.ts'), 'export default 1;\n');
  jest.spyOn(HookRegistrations, 'discover').mockResolvedValue(row);
  jest.spyOn(HookRegistrations, 'setBuildState').mockImplementation(async (_name, state) => {
    states.push(String(state.buildStatus));
    // Each emission follows the state it reports.
    expect(emitHookRegistryChanged).toHaveBeenCalledTimes(states.length - 1);
    return row;
  });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('hook.registry_changed', () => {
  it('is sent when a build starts and again when it fails', async () => {
    buildHookBundle.mockResolvedValue({ success: false, error: 'Unexpected token' });
    const registry = new HookRegistryService({ dir });

    await registry.registerHookFolder('test-script');

    expect(states).toEqual(['building', 'failed']);
    expect(emitHookRegistryChanged.mock.calls).toEqual([[['test-script']], [['test-script']]]);
  });

  it('is not sent for a folder being deleted through Snaglet', async () => {
    const registry = new HookRegistryService({ dir });
    registry.beginManagedDelete('test-script');

    await registry.registerHookFolder('test-script');

    expect(emitHookRegistryChanged).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });
});
