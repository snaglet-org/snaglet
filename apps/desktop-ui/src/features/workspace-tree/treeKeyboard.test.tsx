/**
 * Arrow-key walking between workspace tree rows (WAI-ARIA tree pattern):
 * Up/Down/Home/End move between drawn rows, Right steps into an open row,
 * Left steps out to the parent; a row's own handler (open/close) wins.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { handleTreeNavigationKey } from './treeKeyboard';

function renderTree({
  onProjectKeyDown,
}: { onProjectKeyDown?: (e: React.KeyboardEvent) => void } = {}) {
  render(
    <div role="tree" onKeyDown={handleTreeNavigationKey}>
      <div
        role="treeitem"
        tabIndex={0}
        aria-level={1}
        aria-expanded={true}
        aria-label="Project"
        onKeyDown={onProjectKeyDown}
      >
        <div role="group">
          <div
            role="treeitem"
            tabIndex={0}
            aria-level={2}
            aria-expanded={true}
            aria-label="Threads"
          />
          <div role="treeitem" tabIndex={0} aria-level={3} aria-label="Kickoff">
            <input aria-label="Rename" />
          </div>
        </div>
      </div>
      <div role="treeitem" tabIndex={0} aria-level={1} aria-expanded={false} aria-label="Folders" />
    </div>
  );
  const item = (name: string) => screen.getByRole('treeitem', { name }) as HTMLElement;
  return { item };
}

function press(el: HTMLElement, key: string) {
  el.focus();
  fireEvent.keyDown(el, { key });
}

describe('handleTreeNavigationKey', () => {
  it('moves down and up through the drawn rows, nested ones included', () => {
    const { item } = renderTree();

    press(item('Project'), 'ArrowDown');
    expect(document.activeElement).toBe(item('Threads'));
    press(item('Threads'), 'ArrowDown');
    expect(document.activeElement).toBe(item('Kickoff'));
    press(item('Kickoff'), 'ArrowDown');
    expect(document.activeElement).toBe(item('Folders'));
    press(item('Folders'), 'ArrowDown');
    expect(document.activeElement).toBe(item('Folders'));
    press(item('Folders'), 'ArrowUp');
    expect(document.activeElement).toBe(item('Kickoff'));
  });

  it('jumps to the first and last row with Home and End', () => {
    const { item } = renderTree();

    press(item('Threads'), 'End');
    expect(document.activeElement).toBe(item('Folders'));
    press(item('Folders'), 'Home');
    expect(document.activeElement).toBe(item('Project'));
  });

  it('steps out to the parent with Left and into the first child with Right', () => {
    const { item } = renderTree();

    press(item('Kickoff'), 'ArrowLeft');
    expect(document.activeElement).toBe(item('Threads'));
    press(item('Project'), 'ArrowRight');
    expect(document.activeElement).toBe(item('Threads'));
  });

  it('leaves Left on an open row to the row itself, which closes it', () => {
    const { item } = renderTree();

    press(item('Threads'), 'ArrowLeft');
    expect(document.activeElement).toBe(item('Threads'));
  });

  it('ignores keys a row handled and keys typed into a field', () => {
    const { item } = renderTree({
      onProjectKeyDown: (e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      },
    });

    press(item('Project'), 'ArrowDown');
    expect(document.activeElement).toBe(item('Project'));

    const field = screen.getByRole('textbox', { name: 'Rename' });
    press(field, 'ArrowDown');
    expect(document.activeElement).toBe(field);
  });
});
