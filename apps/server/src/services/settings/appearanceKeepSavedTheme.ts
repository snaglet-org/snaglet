/**
 * One-time step for the default theme's move from the light sage palette to
 * Soft Pastel Garden (dark, 2026-11).
 *
 * A saved theme (`appearance.colors`) holds only the colors someone changed;
 * every other token follows the shipped default. So when the default turns
 * dark, a theme with a few saved colors would show them over the new dark
 * defaults: a white Background someone picked under near-white text. On the
 * first boot after upgrading:
 *
 * - a saved theme with at least one color of its own (one that is not the sage
 *   default) gets the sage default saved for every token it leaves unset, so
 *   it looks exactly as it did and stays the person's theme;
 * - a saved theme whose colors are all sage defaults was never customized:
 *   those colors are removed, so it follows the new default like a fresh
 *   install;
 * - no saved theme: nothing to do, the install gets Soft Pastel Garden.
 *
 * Runs once per install, after the pink cleanup (appearanceColorsCleanup.ts):
 * success records `appearance.colors_default_kept`, and later boots stop
 * there, so a theme saved after the upgrade is never touched. A failed run
 * records nothing and runs again next boot. Cheap: one or two settings reads,
 * at most one merge and one marker write.
 */

import {
  readSavedWorkspaceColors,
  workspaceColorResetPatch,
  workspaceColorTokens,
} from '@snaglet/shared/constants/workspaceTheme';
import { logger } from '@server/config/logger';
import { appearanceSettings } from './categories/appearance';
import { settingsService } from './settingsService';

/** The default palette before Soft Pastel Garden (in force 2026-11-11 to 2026-11). Only this module needs it. */
const SAGE_DEFAULTS: Readonly<Record<string, string>> = {
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

export interface KeptTheme {
  /** `kept`: the saved theme now names every token; `cleared`: it held only old defaults; `none`: nothing changed. */
  outcome: 'kept' | 'cleared' | 'none';
  /** The tokens written (kept) or removed (cleared). */
  tokens: string[];
}

/** Once per install: keep a customized theme's look across the default change, then record that it ran. */
export async function keepSavedThemeOnNewDefault(): Promise<KeptTheme> {
  if (await settingsService.readOptional(appearanceSettings.colorsDefaultKept))
    return { outcome: 'none', tokens: [] };
  const result = await keepSavedTheme();
  await settingsService.write(appearanceSettings.colorsDefaultKept, {
    done: new Date().toISOString(),
  });
  return result;
}

async function keepSavedTheme(): Promise<KeptTheme> {
  const stored = await settingsService.readOptional(appearanceSettings.colors);
  const saved = stored ? readSavedWorkspaceColors(stored) : {};
  const savedNames = Object.keys(saved);
  if (savedNames.length === 0) return { outcome: 'none', tokens: [] };

  if (savedNames.every((name) => saved[name] === SAGE_DEFAULTS[name])) {
    await settingsService.mergeEntries(
      appearanceSettings.colors,
      workspaceColorResetPatch(savedNames)
    );
    logger.info(
      `[settings] the saved theme held only the old default colors (${savedNames.join(', ')}); ` +
        'removed them, so it follows the new default theme'
    );
    return { outcome: 'cleared', tokens: savedNames };
  }

  const unset = workspaceColorTokens
    .map((token) => token.name)
    .filter((name) => !(name in saved) && SAGE_DEFAULTS[name]);
  if (unset.length === 0) return { outcome: 'none', tokens: [] };
  await settingsService.mergeEntries(
    appearanceSettings.colors,
    Object.fromEntries(unset.map((name) => [name, SAGE_DEFAULTS[name]!]))
  );
  logger.info(
    `[settings] kept the customized theme as it looked: saved the previous default for ` +
      `${unset.length} unset color(s), so the new default theme does not change it`
  );
  return { outcome: 'kept', tokens: unset };
}
