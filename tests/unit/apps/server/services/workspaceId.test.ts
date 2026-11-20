/**
 * `workspace.id`: a database keeps the id it has across restarts, gets one
 * when it has none, and gets a new one whenever its content is replaced.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

let stored: string | null = null;
const write = jest.fn(async (_def: unknown, value: string) => {
  stored = value;
  return value;
});

jest.mock('@server/services/settings', () => ({
  settingsService: {
    readOptional: async () => stored,
    write: (def: unknown, value: string) => write(def, value),
  },
}));

import { ensureWorkspaceId, renewWorkspaceId } from '@server/services/workspaceId';
import { workspaceSettings } from '@server/services/settings/categories/workspace';

beforeEach(() => {
  stored = null;
  write.mockClear();
});

describe('workspace id', () => {
  it('keeps the id a database already has', async () => {
    stored = 'workspace-a';
    await expect(ensureWorkspaceId()).resolves.toBe('workspace-a');
    expect(write).not.toHaveBeenCalled();
  });

  it('makes one for a database that has none', async () => {
    const id = await ensureWorkspaceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(write).toHaveBeenCalledWith(workspaceSettings.id, id);
    await expect(ensureWorkspaceId()).resolves.toBe(id);
  });

  it('makes a new one when the content is replaced', async () => {
    stored = 'workspace-a';
    const id = await renewWorkspaceId();
    expect(id).not.toBe('workspace-a');
    expect(stored).toBe(id);
  });
});
