/**
 * The color layer of Snaglet's stylesheet: the palette's custom properties,
 * the tokens derived from it, and the `--color-*` roles the app paints with.
 * `scripts/generate.ts` renders it as `theme.css` and `tokens.scss`; the app
 * loads `tokens.scss` (packages/ui/styles/_tokens.scss), so these are the
 * app's own declarations, not a copy.
 *
 * Dev-time only: not part of the package's JavaScript entry.
 */
import {
  DEFAULT_THEME_NAME,
  defaultTheme,
  deriveThemeTokens,
  THEME_TOKEN_KEYS,
  type ThemePalette,
  type ThemeTokenKey,
} from './index';

/** One `name: value` line, with an optional trailing note. */
export type Declaration = readonly [name: string, value: string, note?: string];

export interface Section {
  title: string;
  /** Comment lines printed under the title. */
  notes?: readonly string[];
  declarations: readonly Declaration[];
}

/** What each palette token paints, in a few words (the Theme view has the full text). */
const PALETTE_NOTES: Record<ThemeTokenKey, string> = {
  disabled: 'dialog veil and app canvas; mixed into faded text and shadows',
  background: 'the page inside each pane',
  foreground: 'pop-up panels, menus, cards',
  'activity-bar': 'far-left icon strip',
  sidebar: 'sidebar panel',
  'status-bar': 'bottom status strip',
  raised: 'buttons, chat message box, badges',
  chrome: 'pane title bars',
  field: 'text boxes, dropdowns, code blocks',
  selected: 'selected and active things',
  text: 'body text',
  'text-muted': 'secondary text, small icons',
  line: 'thin edges and outlines',
  border: 'strong outlines, split-pane line',
  detail: 'main accent (actions, links, focus)',
  'detail-2': 'activity bar icons, tree arrows, idle tabs',
  'color-container-project': 'project icons and badges',
  'color-container-default': 'plain container icons',
  'color-node-doc': 'doc icons and doc chips',
  'color-node-thread': 'thread icons and chips; errors',
  agent: 'flower mood bubble, agent picture frame, mentions',
  'color-node-tool': 'tool icons',
  'color-node-memory': 'memory accents',
  'color-node-image': 'image icons',
};

/** The color layer for `palette`, section by section. */
export function themeSections(palette: ThemePalette = defaultTheme): Section[] {
  const derived = deriveThemeTokens(palette);
  return [
    {
      title: 'Palette',
      notes: [
        `The user-owned role colors, one per Theme view color. These are the`,
        `defaults (${DEFAULT_THEME_NAME}); a saved theme overrides them inline on`,
        `the root element. The tokens below only decide where each role appears.`,
      ],
      declarations: THEME_TOKEN_KEYS.map((key) => [`--${key}`, palette[key], PALETTE_NOTES[key]]),
    },
    {
      title: 'Derived from the palette',
      notes: [
        'Computed from the colors above (deriveThemeTokens) so any palette stays',
        'readable; the app sets them again inline for a saved theme.',
      ],
      declarations: [
        ['--on-selected', derived['on-selected'], 'text on Selected'],
        ['--accent-on-selected', derived['accent-on-selected'], 'accent glyphs on Selected'],
        ['--hover-mix', derived['hover-mix'], 'Selected tint under a hovered row'],
        ['--hover-mix-soft', derived['hover-mix-soft'], 'lighter hover tint'],
        ['color-scheme', derived['color-scheme'], 'native controls match the palette'],
      ],
    },
    {
      title: 'Surface tokens',
      notes: [
        'Large work areas stay calm. The backdrop/theme wash is available as',
        '--color-disabled (Theme view "Disabled") but not used for pane bodies.',
      ],
      declarations: [
        ['--color-disabled', 'var(--disabled)'],
        ['--color-background', 'var(--background)'],
        ['--color-surface-raised', 'var(--raised)'],
        ['--color-surface-sunken', 'var(--field)'],
        ['--color-foreground', 'var(--foreground)'],
      ],
    },
    {
      title: 'App chrome',
      notes: [
        'Each region owns a palette role so the activity bar, the sidebar and',
        'the status bar can be themed independently.',
      ],
      declarations: [
        ['--color-activity-bar', 'var(--activity-bar)'],
        ['--color-sidebar', 'var(--sidebar)'],
        ['--color-sidebar-header', 'color-mix(in srgb, var(--sidebar) 82%, var(--selected))'],
        ['--color-status-bar', 'var(--status-bar)'],
        ['--color-popover', 'var(--raised)'],
        ['--color-chrome', 'var(--chrome)'],
      ],
    },
    {
      title: 'On the chrome bar',
      notes: [
        'Text and controls that sit on the chrome bar. A dedicated role so chrome',
        'text can track the chrome surface independently of the work surface; the',
        'chrome shares the work surface lightness, so it is the body-ink pair.',
      ],
      declarations: [
        ['--color-on-chrome', 'var(--text)'],
        ['--color-on-chrome-muted', 'var(--text-muted)'],
        ['--color-field', 'var(--field)'],
        ['--color-selected', 'var(--selected)'],
      ],
    },
    {
      title: 'Text tokens',
      declarations: [
        ['--color-text', 'var(--text)'],
        ['--color-text-muted', 'var(--text-muted)'],
        ['--color-text-subtle', 'color-mix(in srgb, var(--text) 52%, var(--disabled))'],
        ['--color-text-disabled', 'color-mix(in srgb, var(--text) 36%, var(--disabled))'],
      ],
    },
    {
      title: 'On the Selected color',
      notes: [
        'Text, secondary text and accent glyphs on a solid Selected surface (the',
        'theme-on-selected mixin re-scopes the text roles to these).',
      ],
      declarations: [
        ['--color-on-selected', 'var(--on-selected)'],
        ['--color-primary-on-selected', 'var(--accent-on-selected)'],
        [
          '--color-on-selected-muted',
          'color-mix(in srgb, var(--on-selected) 72%, var(--selected))',
        ],
      ],
    },
    {
      title: 'Border tokens',
      declarations: [
        ['--color-border', 'var(--line)'],
        ['--color-border-strong', 'var(--border)'],
        ['--color-border-subtle', 'color-mix(in srgb, var(--line) 58%, transparent)'],
      ],
    },
    {
      title: 'Hover',
      notes: ['Only color-mix() here. The tint strength is derived (--hover-mix).'],
      declarations: [
        ['--color-hover', 'color-mix(in srgb, var(--selected) var(--hover-mix), var(--raised))'],
        [
          '--color-background-hover',
          'color-mix(in srgb, var(--selected) var(--hover-mix-soft), var(--raised))',
        ],
      ],
    },
    {
      title: 'Primary / accent',
      notes: [
        'Accent is reserved for action, focus, and small highlights. Selected',
        'state has its own role so active rows do not always become CTA-colored.',
      ],
      declarations: [
        ['--color-primary', 'var(--detail)'],
        ['--color-on-primary', 'var(--background)'],
        ['--color-primary-foreground', 'var(--background)'],
        ['--color-primary-bg', 'var(--selected)'],
        ['--color-primary-bg-hover', 'color-mix(in srgb, var(--selected) 72%, var(--raised))'],
        ['--color-primary-border', 'var(--detail)'],
        ['--color-primary-muted', 'var(--detail-2)'],
        ['--color-primary-dark', 'color-mix(in srgb, var(--detail) 78%, var(--background))'],
        ['--color-selection', 'var(--selected)'],
        ['--color-focus-ring', 'color-mix(in srgb, var(--detail) 45%, transparent)'],
      ],
    },
    {
      title: 'Semantic states',
      notes: [
        'State colors borrow from the user palette / node colors so status UI',
        'does not introduce a hidden second theme.',
      ],
      declarations: [
        ['--color-success', 'var(--color-node-task)'],
        ['--color-success-bg', 'color-mix(in srgb, var(--color-success) 18%, var(--field))'],
        ['--color-success-border', 'color-mix(in srgb, var(--color-success) 62%, var(--line))'],
        ['--color-warning', 'var(--detail)'],
        ['--color-warning-bg', 'color-mix(in srgb, var(--color-warning) 16%, var(--field))'],
        ['--color-warning-border', 'color-mix(in srgb, var(--color-warning) 58%, var(--line))'],
        ['--color-error', 'var(--color-node-thread)'],
        ['--color-error-bg', 'color-mix(in srgb, var(--color-error) 18%, var(--field))'],
        ['--color-error-border', 'color-mix(in srgb, var(--color-error) 62%, var(--line))'],
        ['--color-destructive', 'var(--color-error)'],
        ['--color-destructive-bg', 'var(--color-error-bg)'],
        // Aliases for two role names modules commonly reach for.
        ['--color-danger', 'var(--color-error)'],
        ['--color-danger-bg', 'var(--color-error-bg)'],
        ['--color-accent', 'var(--color-primary)'],
        // A blue of its own: the user's Doc color recolors docs, not info states.
        ['--color-info', 'var(--color-select-blue)'],
        ['--color-info-bg', 'color-mix(in srgb, var(--color-info) 18%, var(--field))'],
        ['--color-info-border', 'color-mix(in srgb, var(--color-info) 62%, var(--line))'],
      ],
    },
    {
      title: 'Online/active status light',
      notes: [
        'The pulsing "live" dot and the agent-run indicator on tree rows. White so',
        'it reads calm; the <Light> control paints a hairline ring around it.',
      ],
      declarations: [['--color-status-online', '#ffffff']],
    },
    {
      title: 'Node identity colors',
      notes: [
        'Each -bg is a low-opacity tint over the canvas. Projects wear the Project',
        'color everywhere: tree, pane icons, palette results, badges and chips.',
        'Pane-open is an interaction state, so it keeps the main accent.',
      ],
      declarations: [
        ['--color-node-project', 'var(--color-container-project)'],
        [
          '--color-node-project-bg',
          'color-mix(in srgb, var(--color-node-project) 16%, var(--disabled))',
        ],
        ['--color-pane-open', 'var(--detail)'],
        ['--color-node-container', '#25778b', 'deep teal'],
        [
          '--color-node-container-bg',
          'color-mix(in srgb, var(--color-node-container) 16%, var(--disabled))',
        ],
        ['--color-node-doc-bg', 'color-mix(in srgb, var(--color-node-doc) 16%, var(--disabled))'],
        ['--color-node-file', 'var(--color-select-blue)', 'a fixed blue, not the Doc color'],
        [
          '--color-node-thread-bg',
          'color-mix(in srgb, var(--color-node-thread) 16%, var(--disabled))',
        ],
        ['--color-node-task', '#8ab99a', 'muted sage'],
        ['--color-node-task-bg', 'color-mix(in srgb, var(--color-node-task) 16%, var(--disabled))'],
        ['--color-agent', 'var(--agent)'],
        ['--color-node-agent', 'var(--color-agent)'],
        ['--color-node-tool-bg', 'color-mix(in srgb, var(--color-node-tool) 16%, var(--disabled))'],
        [
          '--color-node-memory-bg',
          'color-mix(in srgb, var(--color-node-memory) 16%, var(--disabled))',
        ],
        [
          '--color-node-image-bg',
          'color-mix(in srgb, var(--color-node-image) 16%, var(--disabled))',
        ],
      ],
    },
    {
      title: 'Select option colors',
      notes: [
        'Swatches for table select options with no node identity to borrow from.',
        'Blue is the default Doc color, copied rather than linked so a changed',
        'Doc color leaves it alone (docColorScope.styles.test.ts).',
      ],
      declarations: [
        ['--color-select-blue', palette['color-node-doc'], 'the default Doc color'],
        ['--color-select-pink', '#f982b0', 'bubblegum pink'],
        ['--color-select-gray', '#b6afb3', 'warm tan'],
        ['--color-select-yellow', '#ffdb57', 'butter yellow'],
        ['--color-select-orange', '#f9a658', 'warm amber'],
        ['--color-select-purple', '#8a79c7', 'soft purple'],
      ],
    },
    {
      title: 'Container category colors',
      declarations: [
        [
          '--color-container-project-bg',
          'color-mix(in srgb, var(--color-container-project) 16%, var(--disabled))',
        ],
        [
          '--color-container-default-bg',
          'color-mix(in srgb, var(--color-container-default) 16%, var(--disabled))',
        ],
      ],
    },
  ];
}

const HEADER = [
  `${DEFAULT_THEME_NAME}: the default Snaglet color theme.`,
  'Generated from packages/theme/src by `pnpm --filter @snaglet/theme generate`.',
  'Do not edit by hand.',
];

function renderRoot(sections: readonly Section[]): string {
  const blocks = sections.map((section) => {
    const lines = [`  /* ${section.title} */`];
    for (const note of section.notes ?? []) lines.push(`  /* ${note} */`);
    for (const [name, value, note] of section.declarations)
      lines.push(`  ${name}: ${value};${note ? ` /* ${note} */` : ''}`);
    return lines.join('\n');
  });
  return `:root {\n${blocks.join('\n\n')}\n}\n`;
}

/** `theme.css`: the color layer as a plain stylesheet. */
export function renderThemeCss(palette: ThemePalette = defaultTheme): string {
  return `/*\n${HEADER.map((line) => ` * ${line}`).join('\n')}\n */\n${renderRoot(themeSections(palette))}`;
}

/**
 * `tokens.scss`: the same `:root` block for Sass consumers (`@use` emits it
 * once), plus the palette as a Sass map.
 */
export function renderTokensScss(palette: ThemePalette = defaultTheme): string {
  const map = THEME_TOKEN_KEYS.map((key) => `  '${key}': ${palette[key]},`).join('\n');
  return (
    `${HEADER.map((line) => `// ${line}`).join('\n')}\n\n` +
    `// The default palette, token key to color.\n$default-theme: (\n${map}\n);\n\n` +
    renderRoot(themeSections(palette))
  );
}
