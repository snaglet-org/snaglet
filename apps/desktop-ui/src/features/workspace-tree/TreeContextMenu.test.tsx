import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { TreeContextMenu } from './TreeContextMenu';
afterEach(cleanup);
it('preserves workspace action order and lets an image be renamed but not copied', () => {
  const callback = vi.fn();
  render(
    <TreeContextMenu
      state={{ x: 0, y: 0, node: { kind: 'image', id: 'image-one' } as LibraryTreeChild }}
      canPaste={false}
      onClose={callback}
      onRename={callback}
      onDuplicate={callback}
      onCopy={callback}
      onPaste={callback}
      onArchive={callback}
    />
  );
  const items = screen.getAllByRole('menuitem') as HTMLButtonElement[];
  expect(items.map((item) => item.textContent)).toEqual([
    'Rename',
    'Duplicate',
    'Copy',
    'Paste',
    'Archive',
  ]);
  expect(items.map((item) => item.disabled)).toEqual([false, true, true, true, false]);
  expect(document.activeElement).toBe(items[0]);
});
it('dispatches the existing tree action after closing', () => {
  const calls: string[] = [];
  const unused = vi.fn();
  render(
    <TreeContextMenu
      state={{ x: 0, y: 0, node: { kind: 'doc', id: 'doc-one' } as LibraryTreeChild }}
      canPaste
      onClose={() => calls.push('close')}
      onRename={() => calls.push('rename')}
      onDuplicate={unused}
      onCopy={unused}
      onPaste={unused}
      onArchive={unused}
    />
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
  expect(calls).toEqual(['close', 'rename']);
});
