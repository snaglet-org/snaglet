import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import { workspaceColorTokens } from '@snaglet/shared/constants/workspaceTheme';

const TOKEN_NAMES = workspaceColorTokens.map((token) => token.name);

// Each token says what it paints, so a model can pick tokens from the schema
// alone. The tool is not core: only a run that fetches or pins it pays for this.
const TOKEN_PROPERTIES = Object.fromEntries(
  workspaceColorTokens.map((token) => [
    token.name,
    { type: 'string', description: `${token.label}: ${token.description}` },
  ])
);

/**
 * change_color_theme(op) — the person's workspace palette (the
 * `appearance.colors` setting the Theme view edits). Not confirm-gated: every
 * set and reset reports each color it replaced (`name old → new`), so one set
 * with the previous colors undoes it, the Theme view can change any color back,
 * and nothing outside this app changes. Every write reaches open windows
 * through the settings surface (`settings:changed`).
 */
const definition: BuiltinToolDefinition = {
  id: 'change_color_theme',
  name: 'Change color theme',
  description:
    "The Snaglet app's color theme, the same palette as Settings → Theme. " +
    'op get: every color token with its current and default color. ' +
    'op set: colors {token: "#rrggbb"} changes one or more tokens at once. ' +
    'op reset: tokens back to their defaults (all when tokens is omitted). ' +
    'Both report each old color, so one set undoes them. Every open Snaglet window updates at once.',
  type: 'builtin',
  tier: 'standard',
  contextRequirement: 'agent-optional',
  keywords: [
    'theme',
    'color theme',
    'colour',
    'colors',
    'palette',
    'appearance',
    'recolor',
    'dark mode',
    'light mode',
    'accent color',
    'background color',
    'text color',
    'workspace theme',
  ],
  parameters_schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['get', 'set', 'reset'] },
      colors: {
        type: 'object',
        description: 'set: token → six-digit hex color "#rrggbb". Only the tokens given change.',
        properties: TOKEN_PROPERTIES,
        additionalProperties: false,
      },
      tokens: {
        type: 'array',
        description: 'reset: the tokens to put back to their defaults; omit to reset every token.',
        items: { type: 'string', enum: TOKEN_NAMES },
      },
    },
    required: ['op'],
    additionalProperties: false,
  },
};

export default definition;
