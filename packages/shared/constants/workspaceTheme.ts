// The user-customizable palette, organized by semantic category: what each
// color is called and paints. Default colors come from @snaglet/theme (the
// Soft Pastel Garden palette), the one source the stylesheet is generated from.
import { defaultTheme } from '@snaglet/theme';

export interface ColorToken {
  name: string; // CSS variable name without --
  label: string; // Display label
  defaultValue: string;
  /**
   * What the color paints on screen, in plain words, most visible first. Shown
   * under the color in the Theme view and to agents in change_color_theme.
   */
  description: string;
  category: string;
}

// Base Palette
export const baseColorTokens: ColorToken[] = [
  {
    name: 'disabled',
    label: 'Disabled',
    defaultValue: defaultTheme.disabled,
    description:
      'The dim veil behind dialogs, the search palette and image previews. Also blended into faded text (placeholders, disabled buttons) and soft shadows.',
    category: 'base',
  },
  {
    name: 'background',
    label: 'Background',
    defaultValue: defaultTheme.background,
    description:
      'The main page inside every pane, behind docs, chats, tables and the calendar. Also the text on accent-colored buttons and tooltips.',
    category: 'base',
  },
  {
    name: 'foreground',
    label: 'Foreground',
    defaultValue: defaultTheme.foreground,
    description:
      'Fill of pop-up panels, menus and cards: right-click menus, the search palette, date pickers, dialogs, your own chat bubbles, table header rows in docs and chats, and board columns.',
    category: 'base',
  },
  {
    name: 'activity-bar',
    label: 'Activity Bar',
    defaultValue: defaultTheme['activity-bar'],
    description:
      'Background of the narrow strip of icons on the far left edge of the window. The icons themselves use Detail 2.',
    category: 'base',
  },
  {
    name: 'sidebar',
    label: 'Sidebar',
    defaultValue: defaultTheme.sidebar,
    description:
      'Background of the panel beside the activity bar that holds the workspace tree and the other sidebar lists. Its header strip mixes in some Selected.',
    category: 'base',
  },
  {
    name: 'status-bar',
    label: 'Status Bar',
    defaultValue: defaultTheme['status-bar'],
    description:
      'Background of the thin strip along the bottom of the window that shows connection, agent and notification status. Its text uses Text Muted.',
    category: 'base',
  },
  {
    name: 'raised',
    label: 'Raised',
    defaultValue: defaultTheme.raised,
    description:
      'Fill of ordinary buttons, the box you type chat messages into, the find bar and small badges. Also blended into every hover highlight.',
    category: 'base',
  },
  {
    name: 'chrome',
    label: 'Chrome',
    defaultValue: defaultTheme.chrome,
    description:
      "The title bar across the top of each pane, with the back and forward buttons and the item's path. The focused pane's bar mixes in Selected.",
    category: 'base',
  },
  {
    name: 'field',
    label: 'Field',
    defaultValue: defaultTheme.field,
    description:
      'Inside of text boxes, dropdowns and date fields. Also chat code blocks, the code editor, switches turned off and the pale fill of error and warning notes.',
    category: 'base',
  },
  {
    name: 'selected',
    label: 'Selected',
    defaultValue: defaultTheme.selected,
    description:
      'Highlight for chosen things: the selected sidebar row, active tabs, switches turned on, pressed buttons, highlighted text and the spot a dragged item will land. Also tints hover highlights.',
    category: 'base',
  },
  {
    name: 'text',
    label: 'Text',
    defaultValue: defaultTheme.text,
    description:
      'The color of almost all words: doc and chat text, headings, names in the sidebar tree, button and menu labels, and pane titles.',
    category: 'base',
  },
  {
    name: 'text-muted',
    label: 'Text Muted',
    defaultValue: defaultTheme['text-muted'],
    description:
      "Secondary words and small icons: timestamps, hints, labels, status bar text, the item's path in pane title bars, and close, copy and add buttons.",
    category: 'base',
  },
  {
    name: 'line',
    label: 'Line',
    defaultValue: defaultTheme.line,
    description:
      'The thin lines everywhere: the edges of the sidebar, status bar and each pane, and the outlines of inputs, buttons, cards, menus and table cells.',
    category: 'base',
  },
  {
    name: 'border',
    label: 'Border',
    defaultValue: defaultTheme.border,
    description:
      'Strong outlines: the thick frame around the focused pane in a split view, the line between split panes, the shaded edge of buttons, and most other scrollbars.',
    category: 'base',
  },
  {
    name: 'detail',
    label: 'Detail',
    defaultValue: defaultTheme.detail,
    description:
      "Main accent: main buttons, links, checkboxes, the hovered right-click menu item, tooltips, focus outlines (including the focused pane's), find highlights, warnings, and scrollbars in the sidebar, docs and chats.",
    category: 'base',
  },
  {
    name: 'detail-2',
    label: 'Detail 2',
    defaultValue: defaultTheme['detail-2'],
    description:
      'Second accent: the activity bar icons, table and file icons and expand arrows in the sidebar tree, sidebar section titles, and tab labels that are not selected.',
    category: 'base',
  },
];

// Container Categories
export const containerColorTokens: ColorToken[] = [
  {
    name: 'color-container-project',
    label: 'Project',
    defaultValue: defaultTheme['color-container-project'],
    description:
      "Project icons in the sidebar tree, container views and pane title bars, the small 'project' badge, and the top stripe of a focused project pane.",
    category: 'container',
  },
  {
    name: 'color-container-default',
    label: 'Default',
    defaultValue: defaultTheme['color-container-default'],
    description:
      'Icons of plain containers (not projects) in the sidebar tree, container views and pane title bars.',
    category: 'container',
  },
];

// Node Types
export const nodeColorTokens: ColorToken[] = [
  {
    name: 'color-node-doc',
    label: 'Doc',
    defaultValue: defaultTheme['color-node-doc'],
    description:
      'Doc icons in the sidebar tree, container views, pane title bars and search results, and the colored doc links (chips) in docs and chats.',
    category: 'node',
  },
  {
    name: 'color-node-thread',
    label: 'Thread',
    defaultValue: defaultTheme['color-node-thread'],
    description:
      'Thread icons and thread links (chips) across the app. Also the error and delete color: error messages, failed runs, delete buttons and memory chips.',
    category: 'node',
  },
  {
    name: 'agent',
    label: 'Agent',
    defaultValue: defaultTheme.agent,
    description:
      "The little mood bubble on agents' flower pictures (like … or ?), the frame behind an uploaded agent picture, and @-mention chips for agents and people.",
    category: 'node',
  },
  {
    name: 'color-node-tool',
    label: 'Tool',
    defaultValue: defaultTheme['color-node-tool'],
    description:
      "Tool icons in the sidebar's Tools list. Also the 'red' option color in table select fields.",
    category: 'node',
  },
  {
    name: 'color-node-memory',
    label: 'Memory',
    defaultValue: defaultTheme['color-node-memory'],
    description:
      "Used in only a few spots: one of the automatic calendar colors and some agents' flower pictures. Memory chips use the Thread color instead.",
    category: 'node',
  },
  {
    name: 'color-node-image',
    label: 'Image',
    defaultValue: defaultTheme['color-node-image'],
    description:
      "Image icons in the sidebar tree, container views and pane title bars. Also the 'red' calendar color.",
    category: 'node',
  },
];

export const workspaceColorTokens = [
  ...baseColorTokens,
  ...containerColorTokens,
  ...nodeColorTokens,
];
export const defaultWorkspaceColors: Record<string, string> = Object.fromEntries(
  workspaceColorTokens.map((token) => [token.name, token.defaultValue])
);
/**
 * The saved-theme change that resets tokens (every token when `names` is left
 * out): each one null, which removes its saved color, so it follows the
 * shipped default from then on, including a later change to that default.
 * The Theme view's resets and change_color_theme's reset both send this.
 * Throws on a name that is not a token.
 */
export function workspaceColorResetPatch(names?: readonly string[]): Record<string, null> {
  const tokens = names ?? Object.keys(defaultWorkspaceColors);
  const unknown = tokens.filter(
    (name) => !Object.prototype.hasOwnProperty.call(defaultWorkspaceColors, name)
  );
  if (unknown.length) throw new Error(`Unknown theme tokens: ${unknown.join(', ')}`);
  return Object.fromEntries(tokens.map((name) => [name, null]));
}
export const WORKSPACE_THEME_GUIDANCE =
  'Use this workspace palette as the starting point for mood boards and SVG graphics. Prefer the text color for readable ink, background/foreground colors for fills, and accents for emphasis. The user’s explicit palette or brand request takes precedence. Preserve existing artwork colors unless asked to restyle it. Use literal hex values, not CSS variable references.';
// Renamed tokens and their successors, so a saved theme using an old key still
// loads. 'panel' covered the sidebar, activity bar and status bar too, so it
// seeds all of them.
export const LEGACY_WORKSPACE_COLOR_KEYS: Record<string, readonly string[]> = {
  bg: ['disabled'],
  canvas: ['disabled'],
  fg: ['background'],
  panel: ['foreground', 'sidebar', 'activity-bar', 'status-bar'],
  'color-node-agent': ['agent'],
  // No successor: a saved status-container color is dropped rather than rejected.
  'color-container-status': [],
};
export function migrateWorkspaceColors(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, color] of Object.entries(input)) {
    const successors = LEGACY_WORKSPACE_COLOR_KEYS[key];
    if (!successors) {
      out[key] = color;
      continue;
    }
    for (const next of successors) if (!(next in input) && !(next in out)) out[next] = color;
  }
  return out;
}
export function parseWorkspaceColors(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Theme colors must be an object');
  const result: Record<string, string> = {};
  for (const [key, color] of Object.entries(migrateWorkspaceColors(value) as object)) {
    if (
      !Object.prototype.hasOwnProperty.call(defaultWorkspaceColors, key) ||
      typeof color !== 'string' ||
      !/^#[0-9a-f]{6}$/i.test(color)
    )
      throw new Error('Theme colors must use known tokens and six-digit hex values');
    result[key] = color.toLowerCase();
  }
  return result;
}
/**
 * A saved theme as the palette reads it today: renamed tokens carried over to
 * their successors, tokens the palette does not declare dropped rather than
 * failing the whole theme, colors lowercased. Throws when a known token holds
 * anything but six-digit hex.
 */
export function readSavedWorkspaceColors(value: unknown): Record<string, string> {
  const migrated = migrateWorkspaceColors(value);
  if (!migrated || typeof migrated !== 'object' || Array.isArray(migrated))
    return parseWorkspaceColors(migrated);
  return parseWorkspaceColors(
    Object.fromEntries(
      Object.entries(migrated).filter(([name]) =>
        Object.prototype.hasOwnProperty.call(defaultWorkspaceColors, name)
      )
    )
  );
}
