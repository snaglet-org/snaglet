/**
 * The settings surface sends `settings:changed` ({category, key}, no value) on
 * the `settings` channel for every write and revert the settings service makes,
 * whatever called it (the settings routes, an agent tool). A failed broadcast
 * never fails the write.
 */
const mockBroadcast = jest.fn();
jest.mock('@snaglet/db/tables/settings', () => ({
  Settings: {
    read: async () => null,
    write: async (category: string, key: string, value: unknown) => ({ category, key, value }),
    remove: async () => true,
  },
}));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...args: unknown[]) => mockBroadcast(...args) },
}));

import { settingsService } from '@server/services/settings';
import { appearanceSettings } from '@server/services/settings/categories/appearance';
import { initSettingsSurface } from '@server/realtime/surfaces/settings';

const frame = { type: 'settings:changed', payload: { category: 'appearance', key: 'colors' } };

beforeEach(() => mockBroadcast.mockReset());

it('broadcasts each write and revert once, without the value, until stopped', async () => {
  const stop = initSettingsSurface();
  initSettingsSurface(); // idempotent: still one frame per change
  try {
    await settingsService.write(appearanceSettings.colors, { text: '#112233' });
    expect(mockBroadcast.mock.calls).toEqual([['settings', frame]]);
    await settingsService.revert(appearanceSettings.colors);
    expect(mockBroadcast).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
  await settingsService.write(appearanceSettings.colors, { text: '#445566' });
  expect(mockBroadcast).toHaveBeenCalledTimes(2);
});

it('keeps the write when the broadcast throws', async () => {
  const stop = initSettingsSurface();
  mockBroadcast.mockImplementation(() => {
    throw new Error('socket gone');
  });
  try {
    await expect(
      settingsService.write(appearanceSettings.colors, { text: '#778899' })
    ).resolves.toEqual({ text: '#778899' });
  } finally {
    stop();
  }
});
