# change_color_theme

Change the Snaglet app's color theme: one color token, several at once, or back to
the defaults. It is the same theme the person edits in **Settings → Theme**, and
every open Snaglet window shows a change at once, without a reload.

- `get` — every token: name, label, what it colors, current color and default.
  Tokens the person changed are marked `*`.
- `set` — `colors` maps tokens to six-digit hex colors (`#rrggbb`, any case).
  Only the tokens given change; the rest keep their colors. An unknown token
  or a color that is not `#rrggbb` (`#abc`, `red`) changes nothing and the
  error names each bad entry.
- `reset` — `tokens` puts those tokens back to their defaults; leave `tokens`
  out to reset the whole theme to the default, Soft Pastel Garden (a dark
  theme: near-black surfaces, off-white text, pastel accents). A reset clears
  the saved color, so the token keeps following Snaglet's default even when a
  later version changes it.

`set` and `reset` list each color they replaced as `name old → new`. To undo
a change, call `set` with the old colors.

```json
{ "op": "set", "colors": { "detail": "#2f6fed", "sidebar": "#eef3ff" } }
```

Tokens: base palette `disabled`, `background`, `foreground`, `activity-bar`,
`sidebar`, `status-bar`, `raised`, `chrome`, `field`, `selected`, `text`,
`text-muted`, `line`, `border`, `detail` (main accent), `detail-2`; containers
`color-container-project`, `color-container-default`; node kinds
`color-node-doc`, `color-node-thread`, `agent`, `color-node-tool`,
`color-node-memory`, `color-node-image`. Each token's description in the
schema, and in `get`, names the parts of the screen it colors. Agent flower
avatars and calendars without a color of their own also borrow theme colors.

Keep text readable: when you change `background` or `foreground`, check `text`
and `text-muted` still contrast with them. When you change `detail` or
`background`, check they contrast too: `background` is the text on accent
buttons. Text on `selected` highlights is picked for you (`text` or
`background`, whichever reads better). The theme is the person's own preference, so change it when they ask,
and tell them what changed.
