/**
 * useTreeRename commits an image rename through the images API, sending the
 * name the row showed so a rename made elsewhere is refused, and reverts the
 * optimistic label when the server refuses.
 */
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageTreeNode, LibraryTreeChild } from '../../../utils/api';

const api = vi.hoisted(() => ({ renameImage: vi.fn() }));

vi.mock('../../../utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/api')>();
  return { ...actual, imagesApi: { ...actual.imagesApi, rename: api.renameImage } };
});

import { onLibraryEvent, type LibraryEvent } from '../../../utils/workspaceEvents';
import { useTreeRename } from './useTreeRename';

const IMAGE: ImageTreeNode = {
  kind: 'image',
  id: 'image-1111111111111-aaaaaaaaa',
  containerId: null,
  name: 'Capture',
  description: null,
  tags: [],
  mimeType: 'image/png',
  url: '/api/images/image-1111111111111-aaaaaaaaa/content',
  sizeBytes: 4,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function setup() {
  const reportError = vi.fn();
  const hook = renderHook(() => {
    const [roots, setRoots] = useState<LibraryTreeChild[] | null>([IMAGE]);
    return { roots, rename: useTreeRename({ setRoots, reportError }) };
  });
  return { ...hook, reportError };
}

let events: LibraryEvent[] = [];
let stop: () => void = () => undefined;

beforeEach(() => {
  vi.resetAllMocks();
  events = [];
  stop = onLibraryEvent((event) => events.push(event));
});

afterEach(() => stop());

describe('useTreeRename for images', () => {
  it('renames through the images API with the shown name as the expected one', async () => {
    api.renameImage.mockResolvedValue({ ...IMAGE, name: 'Sunset' });
    const { result } = setup();

    await act(() => result.current.rename.commitRename(IMAGE, '  Sunset '));

    expect(api.renameImage).toHaveBeenCalledWith(IMAGE.id, 'Sunset', 'Capture');
    expect(result.current.roots?.[0]).toMatchObject({ name: 'Sunset' });
    expect(events).toContainEqual({ type: 'renamed', kind: 'image', id: IMAGE.id, name: 'Sunset' });
  });

  it('reverts the label and reports when the server refuses', async () => {
    api.renameImage.mockRejectedValue(new Error('This image was renamed to "Elsewhere"'));
    const { result, reportError } = setup();

    await act(() => result.current.rename.commitRename(IMAGE, 'Sunset'));

    expect(result.current.roots?.[0]).toMatchObject({ name: 'Capture' });
    expect(reportError).toHaveBeenCalledWith(
      'Rename failed: This image was renamed to "Elsewhere"'
    );
    expect(events.some((event) => event.type === 'renamed')).toBe(false);
  });
});
