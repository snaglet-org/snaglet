/**
 * Escape on the `/` block menu turns it down for that `/` token: typing on
 * in the same token must not reopen it (where Enter would then run a
 * command), while a new `/` opens it again.
 */
import { useState } from 'react';
import type { Editor } from '@tiptap/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { ChipEditableInput } from './ChipEditableInput';

let editor: Editor | null = null;

function Host() {
  const [value, setValue] = useState('');
  return (
    <ChipEditableInput
      value={value}
      onChange={setValue}
      onEditorReady={(next) => {
        editor = next;
      }}
      richBlocks
      multiline
      ariaLabel="Note"
      enableNodeMentions={false}
    />
  );
}

const menu = () => screen.queryByRole('listbox', { name: 'Block commands' });

function type(text: string) {
  act(() => {
    editor!.commands.insertContent({ type: 'text', text });
  });
}

describe('slash menu dismissal', () => {
  beforeAll(() => {
    if (!document.elementFromPoint) document.elementFromPoint = () => null;
    if (!Range.prototype.getClientRects)
      Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    if (!Range.prototype.getBoundingClientRect)
      Range.prototype.getBoundingClientRect = () => new DOMRect();
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
  });

  it('stays closed for the dismissed token and reopens for a new slash', async () => {
    editor = null;
    render(<Host />);
    const box = await screen.findByRole('textbox', { name: 'Note' });
    await waitFor(() => expect(editor).not.toBeNull());
    act(() => {
      editor!.view.focus();
    });

    type('/he');
    expect(menu()).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(menu()).not.toBeInTheDocument();

    // "/hea" still matches Heading: the menu must not come back for it.
    type('a');
    expect(menu()).not.toBeInTheDocument();

    type(' /');
    expect(menu()).toBeInTheDocument();
  });
});
