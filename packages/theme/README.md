# @snaglet/theme

Snaglet's color theme as data. It holds the default theme, **Soft Pastel Garden** (near-black
surfaces, off-white text, pastel accents), and ships it in the forms an app needs: a JavaScript
module, a JSON map, a CSS stylesheet and a Sass partial. It has no runtime dependencies.

Snaglet's UI loads its whole color layer from this package, its server resets themes to it, and the
Snaglet website syncs its colors from `defaultTheme.json`.

## Token keys

Each key is a theme color: the key of a saved theme, of the `change_color_theme` tool and of the
Theme view, and the CSS custom property that paints it (`--<key>`).

| Key                       | Default   | Paints                                            |
| ------------------------- | --------- | ------------------------------------------------- |
| `disabled`                | `#2a2a2a` | dim overlay behind dialogs; the app canvas        |
| `background`              | `#0a0a0a` | the page inside each pane; text on accent buttons |
| `foreground`              | `#1a1a1a` | panels, menus, cards                              |
| `activity-bar`            | `#0f0f0f` | the icon strip on the left edge                   |
| `sidebar`                 | `#0f0f0f` | the sidebar                                       |
| `status-bar`              | `#0f0f0f` | the bottom bar                                    |
| `raised`                  | `#1a1a1a` | buttons, the chat message box, badges             |
| `chrome`                  | `#0f0f0f` | pane title bars                                   |
| `field`                   | `#1e1e1e` | text boxes, dropdowns, code blocks                |
| `selected`                | `#f5b398` | highlights and selections                         |
| `text`                    | `#f5f5f5` | body text                                         |
| `text-muted`              | `#a1a1a1` | secondary text and small icons                    |
| `line`                    | `#f5d5e8` | thin borders                                      |
| `border`                  | `#e291b5` | strong borders                                    |
| `detail`                  | `#e291b5` | the main accent: links, buttons, focus            |
| `detail-2`                | `#d4a5d6` | the second accent: icons, secondary elements      |
| `color-container-project` | `#b8e6d5` | projects                                          |
| `color-container-default` | `#d4e8e1` | plain containers                                  |
| `color-node-doc`          | `#9ed4d1` | docs                                              |
| `color-node-thread`       | `#f5b398` | threads; errors                                   |
| `agent`                   | `#e291b5` | agents and mentions                               |
| `color-node-tool`         | `#e8c4a6` | tools                                             |
| `color-node-memory`       | `#d4a5d6` | memories                                          |
| `color-node-image`        | `#f5b398` | images                                            |

`theme.css` and `tokens.scss` also declare the tokens derived from the palette (`--on-selected`,
`--accent-on-selected`, `--hover-mix`, `--hover-mix-soft` and `color-scheme`) and every `--color-*`
role the app paints with (`--color-background`, `--color-text`, `--color-primary`,
`--color-on-selected`, …).

## Use it

```ts
import { defaultTheme, DEFAULT_THEME_NAME, THEME_TOKEN_KEYS } from '@snaglet/theme';

defaultTheme.background; // '#0a0a0a'
```

```css
@import '@snaglet/theme/theme.css';

body {
  background: var(--color-background);
  color: var(--color-text);
}
```

```scss
@use 'sass:map';
@use '@snaglet/theme/tokens.scss' as theme; // emits the :root block once

.swatch {
  background: map.get(theme.$default-theme, 'detail');
}
```

`@snaglet/theme/defaultTheme.json` is the palette alone: token key to `#rrggbb`, keys sorted.

The module also exports `deriveThemeTokens(palette)`, the derived tokens for any palette, and the
contrast helpers it uses (`contrastRatio`, `relativeLuminance`, `mixHex`).

## How it is generated

The single source is `src/index.ts` (the palette and the derivations) with `src/stylesheet.ts`
(the color roles). `scripts/generate.ts` writes `index.js`, `index.d.ts`, `defaultTheme.json`,
`theme.css` and `tokens.scss`, which are committed, so nothing needs a build step to use them.

```bash
pnpm --filter @snaglet/theme generate   # write the files after changing src/
pnpm --filter @snaglet/theme check      # fail if a committed file is out of date
```

The package's `typecheck` runs the check too (so `pnpm typecheck` and `pnpm verify:changed` do), and
the unit test `tests/unit/packages/theme/defaultTheme.test.ts` runs it with the rest of the tests.
