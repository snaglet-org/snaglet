/**
 * Pure HandlerEditor helpers, kept out of HandlerEditor.tsx so they test
 * without mounting CodeMirror:
 *  - a fixed autocomplete list for `@snaglet/sdk` (packages/snaglet-sdk/src/index.ts),
 *    added alongside CodeMirror's own completions; not a TS language service.
 *  - `hasDefaultExport`, a regex hint that `export default` is present. The
 *    server's esbuild run on deploy is the real check (buildToolBundle.ts).
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';

export interface HandlerEditorMentionRange {
  from: number;
  to: number;
  query: string;
}

/**
 * Find the active `@...` query on the caret's current line. This mirrors the
 * rich editor's mention grammar: `@` must begin a token, spaces are allowed
 * inside the query, and a second `@` or newline ends it.
 */
export function findHandlerEditorMention(
  lineTextBeforeCaret: string,
  lineFrom: number,
  caret: number
): HandlerEditorMentionRange | null {
  const atIndex = lineTextBeforeCaret.lastIndexOf('@');
  if (atIndex < 0) return null;
  const beforeAt = atIndex > 0 ? lineTextBeforeCaret[atIndex - 1] : '';
  if (beforeAt && !/[\s([{]/.test(beforeAt)) return null;
  const query = lineTextBeforeCaret.slice(atIndex + 1);
  if (query.includes('@') || query.length > 120) return null;
  return { from: lineFrom + atIndex, to: caret, query };
}

export const SNAGLET_SDK_COMPLETIONS: readonly Completion[] = [
  {
    label: 'snaglet',
    type: 'namespace',
    info: "@snaglet/sdk's default export — the tool code's entry point back into the Snaglet server.",
  },
  {
    label: 'snaglet.tools.execute',
    type: 'function',
    detail: '(toolName, input?) => Promise<ToolExecuteResult>',
    info: 'Execute another Snaglet tool by name, scoped to the invoking agent’s tool-access policy.',
  },
  {
    label: 'snaglet.tables.read',
    type: 'function',
    detail:
      '(input: { sql } | { table, ids } | { table, where?, sort?, columns?, page? }) => Promise<{ rows: Record<string, string | number | boolean | null | (string | number | boolean | null)[]>[]; fields: string[]; text: string }>',
    info: 'Read a Database table with rows as objects: number fields are numbers, checkboxes booleans, empty cells null, selects their labels, multi-valued fields lists, text, dates and ranges strings. Entry reads start with id and rev. `fields` lists the row keys in order; `text` is exactly what snaglet.tools.execute("table", { op: "read" }) returns. Throws when the read fails.',
  },
  {
    label: 'snaglet.context.get',
    type: 'function',
    detail: '() => ToolContext',
    info: 'The context this invocation ran under: agentId, threadId, triggerMessageId.',
  },
  {
    label: 'snaglet.log.info',
    type: 'function',
    detail: '(message: string) => Promise<void>',
    info: 'Log an info-level message to the tool run output.',
  },
  {
    label: 'snaglet.log.warn',
    type: 'function',
    detail: '(message: string) => Promise<void>',
    info: 'Log a warn-level message to the tool run output.',
  },
  {
    label: 'snaglet.log.error',
    type: 'function',
    detail: '(message: string) => Promise<void>',
    info: 'Log an error-level message to the tool run output.',
  },
];

/**
 * CodeMirror `CompletionSource` for the fixed `SNAGLET_SDK_COMPLETIONS` list.
 * Registered against the TypeScript language's `autocomplete` data facet
 * (`typescriptLanguage.data.of({ autocomplete: snagletSdkCompletionSource })` in
 * HandlerEditor.tsx) so it layers on top of CodeMirror's own
 * local-variable/keyword completions instead of replacing them.
 *
 * Matches on a trailing `[\w.]*` token so it fires for both a bare `snaglet` and
 * a dotted path like `snaglet.tools.`. Returns null (no completions) rather than
 * an empty result when there's nothing to anchor to and the request wasn't
 * explicit (Ctrl+Space) — the CodeMirror-recommended way for a source to
 * decline without blocking other sources.
 */
export function snagletSdkCompletionSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[\w.]*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;
  return {
    from: word.from,
    options: SNAGLET_SDK_COMPLETIONS as Completion[],
    validFor: /^[\w.]*$/,
  };
}

const DEFAULT_EXPORT_RE = /\bexport\s+default\b/;

/**
 * Cheap heuristic — true when the source text contains an `export default`
 * anywhere. Not a real parse (a string literal containing the phrase would
 * false-positive), which is fine: this only drives an optional, non-blocking
 * hint (see module doc comment); the server build is the actual gate.
 */
export function hasDefaultExport(code: string): boolean {
  return DEFAULT_EXPORT_RE.test(code);
}
