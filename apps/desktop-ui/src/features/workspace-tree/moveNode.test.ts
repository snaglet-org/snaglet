import { beforeEach, describe, expect, it, vi } from 'vitest';
import { moveNode } from './moveNode';

const { setPlacement, updateDoc, moveImage } = vi.hoisted(() => ({
  setPlacement: vi.fn(),
  updateDoc: vi.fn(),
  moveImage: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({
  containersApi: { update: vi.fn() },
  docsApi: { update: updateDoc },
  imagesApi: { move: moveImage },
  threadsApi: { setPlacement },
}));

const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';

beforeEach(() => {
  vi.clearAllMocks();
  setPlacement.mockResolvedValue({});
  updateDoc.mockResolvedValue({});
  moveImage.mockResolvedValue({});
});

describe('moveNode', () => {
  it('places a thread in a project at the slot it was dropped on', async () => {
    await moveNode('thread', THREAD_ID, PROJECT_ID, 4);
    expect(setPlacement).toHaveBeenCalledWith(THREAD_ID, { projectId: PROJECT_ID, sortOrder: 4 });
  });

  it('makes a thread flat when the parent is null, leaving the slot to the server', async () => {
    await moveNode('thread', THREAD_ID, null);
    expect(setPlacement).toHaveBeenCalledWith(THREAD_ID, { projectId: null });
  });

  it('keeps folder-placed kinds on their own move paths', async () => {
    await moveNode('doc', 'doc-1111111111111-aaaaaaaaa', PROJECT_ID, 2);
    expect(updateDoc).toHaveBeenCalledWith('doc-1111111111111-aaaaaaaaa', {
      containerId: PROJECT_ID,
      sortOrder: 2,
    });
    await moveNode('image', 'image-1111111111111-aaaaaaaaa', null);
    expect(moveImage).toHaveBeenCalledWith('image-1111111111111-aaaaaaaaa', null, undefined);
    expect(setPlacement).not.toHaveBeenCalled();
  });
});
