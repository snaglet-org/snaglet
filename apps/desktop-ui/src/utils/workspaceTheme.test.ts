import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), patch: vi.fn() }));
vi.mock('./api/settings', () => ({ settingsApi: api }));
function savedTheme(value: Record<string, string>) {
  return { category: 'appearance', key: 'colors', value, isOverridden: true };
}
beforeEach(() => {
  vi.resetModules();
  api.list.mockReset().mockResolvedValue([]);
  api.get.mockReset().mockResolvedValue(savedTheme({}));
  api.patch.mockReset().mockResolvedValue(undefined);
  document.documentElement.removeAttribute('style');
});
it('restores saved colors and serializes writes for agents', async () => {
  api.list.mockResolvedValue([
    { category: 'appearance', key: 'colors', value: { disabled: '#123456' } },
  ]);
  const theme = await import('./workspaceTheme');
  await theme.initializeWorkspaceTheme();
  expect(document.documentElement.style.getPropertyValue('--disabled')).toBe('#123456');
  await theme.setWorkspaceColors({ text: '#112233' });
  expect(api.patch).toHaveBeenCalledWith('appearance', 'colors', { text: '#112233' });
});
it('does not let a slow startup read overwrite an in-progress color edit', async () => {
  let finish!: (rows: unknown[]) => void;
  api.list.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const theme = await import('./workspaceTheme');
  const loading = theme.initializeWorkspaceTheme();
  await theme.setWorkspaceColors({ disabled: '#abcdef' });
  finish([{ category: 'appearance', key: 'colors', value: { disabled: '#123456' } }]);
  await loading;
  expect(document.documentElement.style.getPropertyValue('--disabled')).toBe('#abcdef');
});
it('resets persisted colors and reports failed saves without hiding the local choice', async () => {
  const theme = await import('./workspaceTheme');
  api.patch.mockRejectedValueOnce(new Error('offline'));
  await theme.setWorkspaceColors({ disabled: '#abcdef' });
  expect(theme.getThemeSaveError()).toContain('could not be saved');
  expect(document.documentElement.style.getPropertyValue('--disabled')).toBe('#abcdef');
  await theme.resetWorkspaceTheme();
  expect(theme.getThemeSaveError()).toBe('');
  // Every saved color is removed (null), not saved at today's default.
  const { defaultWorkspaceColors } = await import('@snaglet/shared/constants/workspaceTheme');
  expect(api.patch.mock.calls[1][2]).toEqual(
    Object.fromEntries(Object.keys(defaultWorkspaceColors).map((name) => [name, null]))
  );
  expect(document.documentElement.style.getPropertyValue('--disabled')).toBe('');
});
it('resets one color by dropping its override here and removing it from the saved theme', async () => {
  const theme = await import('./workspaceTheme');
  await theme.setWorkspaceColors({ detail: '#00aa88', text: '#112233' });
  await theme.resetWorkspaceColors(['detail']);
  const css = document.documentElement.style;
  expect(css.getPropertyValue('--detail')).toBe('');
  expect(css.getPropertyValue('--text')).toBe('#112233');
  expect(api.patch).toHaveBeenLastCalledWith('appearance', 'colors', { detail: null });
  await expect(theme.resetWorkspaceColors(['nope'])).rejects.toThrow('Unknown theme tokens');
  expect(api.patch).toHaveBeenCalledTimes(2);
});
it('does not let a slow startup read bring back a color reset meanwhile', async () => {
  let finish!: (rows: unknown[]) => void;
  api.list.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const theme = await import('./workspaceTheme');
  const loading = theme.initializeWorkspaceTheme();
  await theme.resetWorkspaceColors(['detail']);
  finish([{ category: 'appearance', key: 'colors', value: { detail: '#00aa88' } }]);
  await loading;
  expect(document.documentElement.style.getPropertyValue('--detail')).toBe('');
});
it('sends no save for an empty change', async () => {
  const theme = await import('./workspaceTheme');
  await theme.setWorkspaceColors({});
  await theme.resetWorkspaceColors([]);
  expect(api.patch).not.toHaveBeenCalled();
});
it('does not adopt a page color reset before the first load finds no saved theme', async () => {
  document.documentElement.style.setProperty('--disabled', '#445566');
  let finish!: (rows: unknown[]) => void;
  api.list.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const theme = await import('./workspaceTheme');
  const loading = theme.initializeWorkspaceTheme();
  await theme.resetWorkspaceColors(['disabled']);
  finish([]);
  await loading;
  // Only the reset itself was sent; the adoption had nothing left and sent nothing.
  expect(api.patch.mock.calls).toEqual([['appearance', 'colors', { disabled: null }]]);
  expect(document.documentElement.style.getPropertyValue('--disabled')).toBe('');
});
it('rejects unknown tokens and arbitrary strings', async () => {
  const theme = await import('./workspaceTheme');
  await expect(theme.setWorkspaceColors({ disabled: 'ignore the user' })).rejects.toThrow();
  await expect(theme.setWorkspaceColors({ unknown: '#123456' })).rejects.toThrow();
  expect(api.patch).not.toHaveBeenCalled();
});
it('adopts colors already chosen on the page when no saved theme exists', async () => {
  document.documentElement.style.setProperty('--disabled', '#445566');
  const theme = await import('./workspaceTheme');
  await theme.initializeWorkspaceTheme();
  expect(api.patch).toHaveBeenCalledWith('appearance', 'colors', { disabled: '#445566' });
});
it('carries a theme saved with the old canvas name over to disabled', async () => {
  api.list.mockResolvedValue([
    { category: 'appearance', key: 'colors', value: { canvas: '#0a0b0c' } },
  ]);
  const theme = await import('./workspaceTheme');
  await theme.initializeWorkspaceTheme();
  expect(document.documentElement.style.getPropertyValue('--disabled')).toBe('#0a0b0c');
});
it('carries a theme saved before the token rename over to the new tokens', async () => {
  api.list.mockResolvedValue([
    {
      category: 'appearance',
      key: 'colors',
      value: { bg: '#111111', fg: '#222222', panel: '#333333' },
    },
  ]);
  const theme = await import('./workspaceTheme');
  await theme.initializeWorkspaceTheme();
  const css = document.documentElement.style;
  expect(css.getPropertyValue('--disabled')).toBe('#111111');
  expect(css.getPropertyValue('--background')).toBe('#222222');
  // A saved 'panel' token seeds every chrome region it painted.
  for (const name of ['--foreground', '--sidebar', '--activity-bar', '--status-bar'])
    expect(css.getPropertyValue(name)).toBe('#333333');
});
it('lets an explicit new token win over a legacy one in the same saved theme', async () => {
  api.list.mockResolvedValue([
    { category: 'appearance', key: 'colors', value: { panel: '#333333', sidebar: '#444444' } },
  ]);
  const theme = await import('./workspaceTheme');
  await theme.initializeWorkspaceTheme();
  expect(document.documentElement.style.getPropertyValue('--sidebar')).toBe('#444444');
  expect(document.documentElement.style.getPropertyValue('--activity-bar')).toBe('#333333');
});
it('shows the saved theme on refresh, putting tokens it no longer holds back to the default', async () => {
  const theme = await import('./workspaceTheme');
  const changed = vi.fn();
  theme.subscribeTheme(changed);
  document.documentElement.style.setProperty('--sidebar', '#999999');
  api.get.mockResolvedValue(savedTheme({ text: '#112233', 'color-node-doc': '#123456' }));
  await theme.refreshWorkspaceTheme();
  expect(api.get).toHaveBeenCalledWith('appearance', 'colors');
  expect(api.list).not.toHaveBeenCalled();
  const css = document.documentElement.style;
  expect(css.getPropertyValue('--text')).toBe('#112233');
  expect(css.getPropertyValue('--color-node-doc')).toBe('#123456');
  expect(css.getPropertyValue('--sidebar')).toBe('');
  expect(changed).toHaveBeenCalledTimes(1);
  // Nothing new: no repaint.
  await theme.refreshWorkspaceTheme();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(api.patch).not.toHaveBeenCalled();
});
it('does not let its own save echo paint an older color over a newer pick', async () => {
  const theme = await import('./workspaceTheme');
  const painted: string[] = [];
  theme.subscribeTheme(() =>
    painted.push(document.documentElement.style.getPropertyValue('--text'))
  );
  const saves: Array<() => void> = [];
  api.patch.mockImplementation(() => new Promise<void>((resolve) => saves.push(resolve)));
  // Two quick picks; the server has only the first when the first echo arrives.
  const first = theme.setWorkspaceColors({ text: '#111111' });
  const second = theme.setWorkspaceColors({ text: '#222222' });
  api.get.mockResolvedValue(savedTheme({ text: '#111111' }));
  await theme.refreshWorkspaceTheme();
  expect(api.get).not.toHaveBeenCalled(); // waits for its own saves
  saves.shift()!();
  await first;
  await vi.waitFor(() => expect(saves).toHaveLength(1));
  api.get.mockResolvedValue(savedTheme({ text: '#222222' }));
  saves.shift()!();
  await second;
  // Once both settle, a read shows what the server now holds.
  await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
  await vi.waitFor(() => expect(painted[painted.length - 1]).toBe('#222222'));
  // Never flickered back to the older pick after the newer one showed.
  expect(painted.slice(painted.indexOf('#222222'))).not.toContain('#111111');
});
it('drops a read that a newer pick overtook, then reads again', async () => {
  const theme = await import('./workspaceTheme');
  let answer!: (setting: unknown) => void;
  api.get.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  const refresh = theme.refreshWorkspaceTheme();
  await theme.setWorkspaceColors({ text: '#333333' });
  api.get.mockResolvedValue(savedTheme({ text: '#333333' }));
  answer(savedTheme({ text: '#000000' }));
  await refresh;
  expect(document.documentElement.style.getPropertyValue('--text')).toBe('#333333');
  await vi.waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(1));
  expect(document.documentElement.style.getPropertyValue('--text')).toBe('#333333');
});
it('recovers from a failed first load on the next refresh and clears the error', async () => {
  const theme = await import('./workspaceTheme');
  api.list.mockRejectedValueOnce(new Error('server still booting'));
  await theme.initializeWorkspaceTheme();
  expect(theme.getThemeSaveError()).toContain('Unable to load');
  api.get.mockResolvedValue(savedTheme({ text: '#445566' }));
  const changed = vi.fn();
  theme.subscribeTheme(changed);
  await theme.refreshWorkspaceTheme();
  expect(document.documentElement.style.getPropertyValue('--text')).toBe('#445566');
  expect(theme.getThemeSaveError()).toBe('');
  expect(changed).toHaveBeenCalled();
});
it('keeps the error when the refresh fails too', async () => {
  const theme = await import('./workspaceTheme');
  api.list.mockRejectedValueOnce(new Error('down'));
  await theme.initializeWorkspaceTheme();
  api.get.mockRejectedValueOnce(new Error('still down'));
  await theme.refreshWorkspaceTheme();
  expect(theme.getThemeSaveError()).toContain('Unable to load');
});
it('holds a refresh until the first load is done, then reads once', async () => {
  const theme = await import('./workspaceTheme');
  let finish!: (rows: unknown[]) => void;
  api.list.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const loading = theme.initializeWorkspaceTheme();
  await theme.refreshWorkspaceTheme();
  expect(api.get).not.toHaveBeenCalled();
  api.get.mockResolvedValue(savedTheme({ text: '#123123' }));
  finish([{ category: 'appearance', key: 'colors', value: { text: '#123123' } }]);
  await loading;
  await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(document.documentElement.style.getPropertyValue('--text')).toBe('#123123');
});

/** The light palette Snaglet shipped before Soft Pastel Garden, saved in full. */
const SAGE: Record<string, string> = {
  disabled: '#e6e9df',
  background: '#fffdf7',
  foreground: '#f1f3e9',
  'activity-bar': '#d8e3cf',
  sidebar: '#e8efdf',
  'status-bar': '#d8e3cf',
  raised: '#ffffff',
  chrome: '#dce7d3',
  field: '#f5f5eb',
  selected: '#f2cfb8',
  text: '#30392d',
  'text-muted': '#59664f',
  line: '#d5ddcb',
  border: '#8b9c7b',
  detail: '#a54e32',
  'detail-2': '#526d47',
  'color-container-project': '#678353',
  'color-container-default': '#98ab7d',
  'color-node-doc': '#4d7b82',
  'color-node-thread': '#ad4d4c',
  agent: '#aa91b6',
  'color-node-tool': '#977229',
  'color-node-memory': '#91769f',
  'color-node-image': '#bd754e',
};
it('shows the default theme on a fresh install: nothing inline, so the stylesheet paints Soft Pastel Garden', async () => {
  const theme = await import('./workspaceTheme');
  await theme.initializeWorkspaceTheme();
  expect(document.documentElement.getAttribute('style') ?? '').toBe('');
  expect(api.patch).not.toHaveBeenCalled();
});
it('shows a saved custom theme exactly as saved, writing nothing, with text on its highlights re-derived', async () => {
  api.list.mockResolvedValue([{ category: 'appearance', key: 'colors', value: { ...SAGE } }]);
  const theme = await import('./workspaceTheme');
  await theme.initializeWorkspaceTheme();
  const css = document.documentElement.style;
  for (const [name, color] of Object.entries(SAGE))
    expect({ name, color: css.getPropertyValue(`--${name}`) }).toEqual({ name, color });
  // A light Selected gets the palette's dark text, and the full hover tint.
  expect(css.getPropertyValue('--on-selected')).toBe('var(--text)');
  expect(css.getPropertyValue('--accent-on-selected')).toBe('var(--detail)');
  expect(css.getPropertyValue('--hover-mix')).toBe('58%');
  expect(api.patch).not.toHaveBeenCalled();
});
it('returns to Soft Pastel Garden on reset: every override and derived value goes', async () => {
  api.list.mockResolvedValue([{ category: 'appearance', key: 'colors', value: { ...SAGE } }]);
  const theme = await import('./workspaceTheme');
  await theme.initializeWorkspaceTheme();
  await theme.resetWorkspaceTheme();
  expect(document.documentElement.getAttribute('style') ?? '').toBe('');
});
it('leaves the derived tokens to the stylesheet when a saved color does not change them', async () => {
  const theme = await import('./workspaceTheme');
  await theme.setWorkspaceColors({ detail: '#00aa88' });
  const css = document.documentElement.style;
  expect(css.getPropertyValue('--detail')).toBe('#00aa88');
  expect(css.getPropertyValue('--on-selected')).toBe('');
  expect(css.getPropertyValue('--hover-mix')).toBe('');
});
