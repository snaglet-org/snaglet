import { z } from 'zod';
import {
  defaultWorkspaceColors,
  parseWorkspaceColors,
  readSavedWorkspaceColors,
} from '@snaglet/shared/constants/workspaceTheme';
import { defineCategory } from '../defineSetting';
export const appearanceSettings = defineCategory('appearance', {
  colors: {
    key: 'colors',
    schema: z.record(z.string(), z.string()).superRefine((value, ctx) => {
      try {
        parseWorkspaceColors(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Use known theme tokens and six-digit hex colors',
        });
      }
    }),
    default: {} as Record<string, string>,
    description: 'Personal workspace color overrides shared by the desktop and drawing agents.',
    // A token absent here shows the shipped default, so a reset (Theme view or
    // change_color_theme) sends the token as null to remove its override.
    nullRemovesEntry: true,
    // A theme saved before a token rename is carried over to today's names
    // before a write changes it, so a reset by today's names reaches it too.
    normalize: readSavedWorkspaceColors,
    // Writes name tokens only; anything else is refused (400 over HTTP).
    entryKeys: Object.keys(defaultWorkspaceColors),
  },
  colorsCleanup: {
    key: 'colors_cleanup',
    schema: z.object({ done: z.string() }).nullable(),
    default: null,
    description:
      'Internal: when Snaglet dropped the theme colors an older Reset had saved at the old pink defaults (appearanceColorsCleanup.ts). Set once; while set the cleanup never runs again.',
  },
  colorsDefaultKept: {
    key: 'colors_default_kept',
    schema: z.object({ done: z.string() }).nullable(),
    default: null,
    description:
      'Internal: when Snaglet kept a customized theme looking as it did across the default theme change to Soft Pastel Garden (appearanceKeepSavedTheme.ts). Set once; while set the step never runs again.',
  },
});
