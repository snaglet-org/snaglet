const read = jest.fn();
jest.mock('@server/services/settings', () => ({
  settingsService: { read: (...a: unknown[]) => read(...a) },
}));
jest.mock('@server/services/settings/categories/appearance', () => ({
  appearanceSettings: { colors: {} },
}));

import {
  getWorkspacePalette,
  getWorkspaceThemeColors,
} from '@server/services/BrowserController/workspaceTheme';
import { defaultWorkspaceColors } from '@snaglet/shared/constants/workspaceTheme';

describe('getWorkspaceThemeColors', () => {
  it('returns defaults when nothing is saved', async () => {
    read.mockResolvedValue({});
    expect(await getWorkspaceThemeColors()).toEqual({
      background: defaultWorkspaceColors.background,
      text: defaultWorkspaceColors.text,
      border: defaultWorkspaceColors.border,
      textMuted: defaultWorkspaceColors['text-muted'],
    });
  });
  it('overlays partial saved settings on the defaults', async () => {
    read.mockResolvedValue({ background: '#112233', text: '#ABCDEF' });
    const c = await getWorkspaceThemeColors();
    expect(c.background).toBe('#112233');
    expect(c.text).toBe('#abcdef');
    expect(c.border).toBe(defaultWorkspaceColors.border);
  });
  it('falls back to defaults on invalid or failing settings', async () => {
    read.mockResolvedValue({ nope: 'x' });
    expect((await getWorkspaceThemeColors()).background).toBe(defaultWorkspaceColors.background);
    read.mockRejectedValue(new Error('db'));
    expect((await getWorkspaceThemeColors()).text).toBe(defaultWorkspaceColors.text);
  });
});

describe('getWorkspacePalette', () => {
  it('returns every token with defaults', async () => {
    read.mockResolvedValue({});
    expect(await getWorkspacePalette()).toEqual(defaultWorkspaceColors);
  });
  it('overlays saved colors and never throws', async () => {
    read.mockResolvedValue({ background: '#112233' });
    const p = await getWorkspacePalette();
    expect(p.background).toBe('#112233');
    expect(p.text).toBe(defaultWorkspaceColors.text);
    read.mockRejectedValue(new Error('db'));
    expect(await getWorkspacePalette()).toEqual(defaultWorkspaceColors);
  });
});
