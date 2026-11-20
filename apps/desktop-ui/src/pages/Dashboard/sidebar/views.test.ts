import { describe, expect, it } from 'vitest';
import { SIDEBAR_TAB_IDS } from '@snaglet/shared/types';
import { DEFAULT_SIDEBAR_VIEW, sidebarViewFromStorage } from './views';

describe('sidebar view ids', () => {
  it('restores every live activity-bar view', () => {
    for (const id of ['library', 'calendar', 'agents', 'tools', 'automations', 'settings']) {
      expect(sidebarViewFromStorage(id)).toBe(id);
    }
  });

  it('opens Automations for a persisted Hooks view: scripts list there now', () => {
    expect(SIDEBAR_TAB_IDS).not.toContain('hooks');
    expect(sidebarViewFromStorage('hooks')).toBe('automations');
  });

  it('falls back to the workspace for the retired Database and Discussions views, junk or nothing', () => {
    // Dashboard reads localStorage through this; a stored 'database' or
    // 'board' (ids with no sidebar view) must not pass.
    expect(DEFAULT_SIDEBAR_VIEW).toBe('library');
    expect(sidebarViewFromStorage('database')).toBe('library');
    expect(sidebarViewFromStorage('board')).toBe('library');
    expect(sidebarViewFromStorage('toString')).toBe('library');
    expect(sidebarViewFromStorage(null)).toBe('library');
  });
});
