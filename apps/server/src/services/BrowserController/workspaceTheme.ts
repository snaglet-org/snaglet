import {
  defaultWorkspaceColors,
  parseWorkspaceColors,
} from '@snaglet/shared/constants/workspaceTheme';
import { settingsService } from '@server/services/settings';
import { appearanceSettings } from '@server/services/settings/categories/appearance';

export interface WorkspaceThemeColors {
  background: string;
  text: string;
  border: string;
  textMuted: string;
}

/** The user's saved workspace colors (appearance/colors setting) with defaults for unset tokens. */
export async function getWorkspaceThemeColors(): Promise<WorkspaceThemeColors> {
  let saved: Record<string, string> = {};
  try {
    saved = parseWorkspaceColors(await settingsService.read(appearanceSettings.colors));
  } catch {
    // unreadable or invalid settings fall back to the defaults
  }
  const c = { ...defaultWorkspaceColors, ...saved };
  return {
    background: c.background,
    text: c.text,
    border: c.border,
    textMuted: c['text-muted'],
  };
}

/** Every workspace color token mapped to a concrete color (saved values over defaults). Never throws. */
export async function getWorkspacePalette(): Promise<Record<string, string>> {
  let saved: Record<string, string> = {};
  try {
    saved = parseWorkspaceColors(await settingsService.read(appearanceSettings.colors));
  } catch {
    // unreadable or invalid settings fall back to the defaults
  }
  return { ...defaultWorkspaceColors, ...saved };
}
