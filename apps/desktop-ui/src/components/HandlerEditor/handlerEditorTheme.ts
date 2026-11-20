/**
 * CodeMirror theme for HandlerEditor — wired to the app's existing
 * `--color-*`/`--font-*` custom properties (styles/_tokens.scss) instead of
 * hardcoded colors, so the editor inherits the warm, single-light,
 * sharp-corner design system automatically rather than shipping a second,
 * foreign color scheme. `EditorView.theme()` and `HighlightStyle.define()`
 * both accept any valid CSS value, so a literal `var(--color-text)`
 * works exactly like a hex code and stays in sync with the token file with
 * zero duplication — retint the app, the editor retints with it.
 *
 * Palette choices for syntax highlighting deliberately stay inside the
 * existing "user-owned role palette" rather than borrowing the node-identity
 * hues (--color-node-*): those are reserved for tree/node kind and reusing
 * them here would make a string literal visually claim to be "a task", which
 * is confusing. Instead: --color-primary (berry accent) for keywords,
 * --detail-2 (plum secondary accent) for strings/types, and the existing
 * muted-text tokens for everything else — the same restrained, low-color
 * vocabulary the rest of the app uses.
 */
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export function handlerEditorTheme(): Extension {
  const editorTheme = EditorView.theme(
    {
      '&': {
        color: 'var(--color-text)',
        backgroundColor: 'var(--color-surface-sunken)',
        fontSize: '12px',
        height: '100%',
      },
      '.cm-content': {
        fontFamily: 'var(--font-mono)',
        caretColor: 'var(--color-primary)',
        padding: '10px 0',
      },
      '.cm-line': {
        padding: '0 10px',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--color-primary)',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.5',
        overflow: 'auto',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--color-surface-sunken)',
        color: 'var(--color-text-disabled)',
        border: 'none',
        borderRight: '1px solid var(--color-border-subtle)',
      },
      '.cm-gutterElement': {
        // Matches --font-mono at the same 12px body size so line numbers
        // don't visually mismatch the code they're numbering.
        fontSize: '11px',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'color-mix(in srgb, var(--color-text) 6%, transparent)',
        color: 'var(--color-text-muted)',
      },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--color-text) 4%, transparent)',
      },
      // A tint rather than solid Selected: CodeMirror draws the selection under
      // the text, which keeps its own color, so a solid peach behind the dark
      // theme's light text would not read. --hover-mix keeps text at 4.5:1.
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor:
          'color-mix(in srgb, var(--color-selected) var(--hover-mix), transparent) !important',
      },
      '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)',
        outline: '1px solid var(--color-primary-border)',
      },
      '.cm-tooltip': {
        backgroundColor: 'var(--color-popover)',
        border: '1px solid var(--color-border)',
        borderRadius: '0', // sharp corners — house style, no curved popovers
        fontFamily: 'var(--font-body)',
        fontSize: 'var(--text-xs)',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily: 'var(--font-mono)',
      },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'var(--color-primary-bg) !important',
        color: 'var(--color-on-selected)',
      },
      '.cm-placeholder': {
        color: 'var(--color-text-disabled)',
      },
    },
    { dark: false }
  );

  const highlightStyle = HighlightStyle.define([
    {
      tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword],
      color: 'var(--color-primary)',
      fontWeight: '600',
    },
    { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--detail-2)' },
    {
      tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
      color: 'var(--color-text-subtle)',
      fontStyle: 'italic',
    },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--color-text)' },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName)],
      color: 'var(--color-text)',
      fontWeight: '600',
    },
    { tag: [t.typeName, t.className, t.namespace], color: 'var(--detail-2)' },
    { tag: t.propertyName, color: 'var(--color-text)' },
    { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--color-text-muted)' },
    { tag: t.invalid, color: 'var(--color-error)', textDecoration: 'underline wavy' },
  ]);

  return [editorTheme, syntaxHighlighting(highlightStyle)];
}
