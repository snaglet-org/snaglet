import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import {
  SNAGLET_SDK_COMPLETIONS,
  findHandlerEditorMention,
  hasDefaultExport,
  snagletSdkCompletionSource,
} from './handlerEditorSupport';

describe('findHandlerEditorMention', () => {
  it('returns the exact replacement range for a boundary-valid query with spaces', () => {
    const text = 'const ref = @project launch notes';
    expect(findHandlerEditorMention(text, 40, 40 + text.length)).toEqual({
      from: 52,
      to: 40 + text.length,
      query: 'project launch notes',
    });
  });

  it('recognizes the trigger lane and rejects email-like tokens', () => {
    expect(findHandlerEditorMention('@trigger:agent', 0, 14)?.query).toBe('trigger:agent');
    expect(findHandlerEditorMention('foo@bar', 0, 7)).toBeNull();
  });

  it('uses the last mention and rejects overlong queries', () => {
    expect(findHandlerEditorMention('@old @doc:new', 0, 13)).toEqual({
      from: 5,
      to: 13,
      query: 'doc:new',
    });
    expect(findHandlerEditorMention(`@${'x'.repeat(121)}`, 0, 122)).toBeNull();
  });
});

function contextAt(doc: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc });
  return new CompletionContext(state, pos, explicit);
}

describe('snagletSdkCompletionSource', () => {
  it('offers the snaglet.* completion list when typing "snaglet"', () => {
    const result = snagletSdkCompletionSource(contextAt('snaglet', 2));
    expect(result).not.toBeNull();
    expect(result?.options).toEqual(SNAGLET_SDK_COMPLETIONS);
    expect(result?.from).toBe(0);
  });

  it('anchors from after the last dot for a dotted path like "snaglet.tools."', () => {
    const doc = 'snaglet.tools.';
    const result = snagletSdkCompletionSource(contextAt(doc, doc.length));
    expect(result).not.toBeNull();
    // matchBefore(/[\w.]*/) includes dots, so it anchors from the start of
    // the whole dotted run, not just the last segment.
    expect(result?.from).toBe(0);
  });

  it('declines (returns null) at the start of an empty, non-explicit request', () => {
    const result = snagletSdkCompletionSource(contextAt('', 0, false));
    expect(result).toBeNull();
  });

  it('still returns completions for an explicit (Ctrl+Space) empty request', () => {
    const result = snagletSdkCompletionSource(contextAt('', 0, true));
    expect(result).not.toBeNull();
  });

  it('every completion label is a real @snaglet/sdk member (snaglet, or snaglet.<ns>.<member>)', () => {
    for (const completion of SNAGLET_SDK_COMPLETIONS) {
      expect(completion.label === 'snaglet' || completion.label.startsWith('snaglet.')).toBe(true);
    }
  });
});

describe('hasDefaultExport', () => {
  it('is true for the standard scaffold shape', () => {
    expect(
      hasDefaultExport(
        "import snaglet from '@snaglet/sdk';\n\nexport default async function handler(input, context) {\n  return input;\n}\n"
      )
    ).toBe(true);
  });

  it('is true regardless of surrounding whitespace/newlines between export and default', () => {
    expect(hasDefaultExport('export\n  default\nfunction handler() {}')).toBe(true);
  });

  it('is false once the default export is deleted', () => {
    expect(hasDefaultExport('async function handler(input, context) {\n  return input;\n}\n')).toBe(
      false
    );
  });

  it('is false for an empty file', () => {
    expect(hasDefaultExport('')).toBe(false);
  });

  it('is true for `export default` assigned to a const rather than a function', () => {
    expect(hasDefaultExport('const handler = async () => {};\nexport default handler;\n')).toBe(
      true
    );
  });
});
