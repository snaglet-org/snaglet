import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { DocumentFind } from './DocumentFind';
import { PaneFindProvider } from './PaneFindContext';

const editors: Editor[] = [];

function makeEditor(content: string): Editor {
  const element = document.body.appendChild(document.createElement('div'));
  const editor = new Editor({ element, extensions: [StarterKit], content });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.splice(0).forEach((editor) => {
    editor.view.dom.parentElement?.remove();
    editor.destroy();
  });
});

describe('DocumentFind in the rich editor', () => {
  // jsdom has no layout: selection scrolling and scrollIntoView need stubs.
  beforeAll(() => {
    if (!document.elementFromPoint) document.elementFromPoint = () => null;
    if (!Range.prototype.getClientRects)
      Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    if (!Range.prototype.getBoundingClientRect)
      Range.prototype.getBoundingClientRect = () => new DOMRect();
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
  });

  it('scrolls to the match when navigating, but not on every keystroke in the document', () => {
    const editor = makeEditor('<p>target one</p><p>target two</p>');
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    render(
      <PaneFindProvider isActive>
        <DocumentFind
          editor={editor}
          source={false}
          value=""
          onChange={vi.fn()}
          sourceRef={createRef<HTMLTextAreaElement>()}
          disabled={false}
        />
      </PaneFindProvider>
    );
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in document' }), {
      target: { value: 'target' },
    });
    expect(scroll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByRole('status')).toHaveTextContent('2 of 2');

    scroll.mockClear();
    act(() => {
      editor.view.focus();
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      editor.commands.insertContent(' typed');
    });
    expect(editor.view.hasFocus()).toBe(true);
    expect(editor.state.doc.textContent).toContain('two typed');
    expect(scroll).not.toHaveBeenCalled();
  });
});
