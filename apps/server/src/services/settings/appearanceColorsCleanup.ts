/**
 * One-time cleanup of color themes an older "Reset" pinned.
 *
 * Until 2026-11, "Reset all to defaults" (and change_color_theme's reset)
 * saved every token at the default of the time instead of removing the saved
 * colors, so anyone who reset kept the pink-and-lilac palette after the
 * defaults moved on. On the first boot after upgrading, this drops every saved
 * color that still equals that palette's default for its token, so those
 * tokens follow today's default; any other saved color stays.
 *
 * It runs once per install: success records `appearance.colors_cleanup`, and
 * every later boot sees it and stops, so a color picked after the upgrade that
 * happens to equal an old default (white for Background) is never dropped. A
 * run that fails records nothing and is retried next boot. Cheap: one or two
 * settings reads, at most one merge and one marker write.
 */

import {
  readSavedWorkspaceColors,
  workspaceColorResetPatch,
} from '@snaglet/shared/constants/workspaceTheme';
import { logger } from '@server/config/logger';
import { appearanceSettings } from './categories/appearance';
import { settingsService } from './settingsService';

/** The default palette before the sage one (in force 2026-10-20 to 2026-11-11). Only this module needs it. */
const PINK_DEFAULTS: Readonly<Record<string, string>> = {
  disabled: '#f4ecf3',
  background: '#ffffff',
  foreground: '#ffd6fe',
  'activity-bar': '#fff2db',
  sidebar: '#ffdbe8',
  'status-bar': '#fff2db',
  raised: '#ffffff',
  chrome: '#ff8f8f',
  field: '#d3d6fe',
  selected: '#fab3c4',
  text: '#19141a',
  'text-muted': '#910094',
  line: '#fbbcd7',
  border: '#652a49',
  detail: '#fd3887',
  'detail-2': '#ff6d6d',
  'color-container-project': '#ffb3d9',
  'color-container-default': '#9fd8ff',
  'color-node-doc': '#52a3ff',
  'color-node-thread': '#f887d4',
  agent: '#c9b6ff',
  'color-node-tool': '#ffd36e',
  'color-node-memory': '#d59cf0',
  'color-node-image': '#ff8870',
};

/**
 * Once per install: remove the saved colors that equal the pink palette's
 * default for their token, then record that it ran. Returns the tokens
 * removed (none when it already ran or found nothing).
 */
export async function dropPinnedPinkDefaults(): Promise<string[]> {
  if (await settingsService.readOptional(appearanceSettings.colorsCleanup)) return [];
  const removed = await removePinned();
  await settingsService.write(appearanceSettings.colorsCleanup, {
    done: new Date().toISOString(),
  });
  return removed;
}

async function removePinned(): Promise<string[]> {
  const stored = await settingsService.readOptional(appearanceSettings.colors);
  if (!stored) return [];
  const saved = readSavedWorkspaceColors(stored);
  const pinned = Object.keys(saved).filter((name) => saved[name] === PINK_DEFAULTS[name]);
  if (pinned.length === 0) return [];
  await settingsService.mergeEntries(appearanceSettings.colors, workspaceColorResetPatch(pinned));
  logger.info(
    `[settings] dropped ${pinned.length} theme color(s) an earlier Reset saved at the old ` +
      `default, so they follow today's defaults: ${pinned.join(', ')}`
  );
  return pinned;
}
