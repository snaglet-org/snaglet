/**
 * WikiLinkPreviewModal — an image chip previews through the shared pan/zoom
 * ImageViewer, and the viewer takes focus so its zoom keys work at once.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StoredImage } from '@desktop/utils/api';
import { WikiLinkPreviewModal } from './WikiLinkPreviewModal';

const api = vi.hoisted(() => ({ getMetadata: vi.fn() }));
vi.mock('@desktop/utils/api', async (original) => ({
  ...(await original<typeof import('@desktop/utils/api')>()),
  imagesApi: api,
}));
vi.mock('@desktop/features/rich-markdown/renderer/useWorkspaceAncestors', () => ({
  useWorkspaceAncestors: () => [],
}));
vi.mock('@desktop/hooks/useAuthenticatedImage', () => ({
  useAuthenticatedImage: (imageId: string | null | undefined) => ({
    blobUrl: imageId ? `blob:${imageId}` : null,
    loading: false,
    error: null,
  }),
}));

const IMAGE_ID = 'image-1111111111111-aaaaaaaaa';
const image: StoredImage = {
  id: IMAGE_ID,
  containerId: null,
  name: 'diagram.png',
  description: null,
  tags: [],
  mimeType: 'image/png',
  sizeBytes: 2048,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  url: `/api/images/${IMAGE_ID}/content`,
};

beforeEach(() => {
  api.getMetadata.mockResolvedValue(image);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1600);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(900);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('previews an image chip in the pan/zoom viewer, focused and zoomable', async () => {
  render(<WikiLinkPreviewModal kind="image" id={IMAGE_ID} onClose={vi.fn()} />);

  const img = await screen.findByRole('img', { name: 'diagram.png' });
  expect(img).toHaveAttribute('src', `blob:${IMAGE_ID}`);
  fireEvent.load(img);

  const viewer = screen.getByRole('group', { name: 'Image viewer' });
  expect(viewer).toHaveFocus();
  // 1600×900 in the 800×600 body, less 24px of fit padding on each side.
  expect(screen.getByRole('status')).toHaveTextContent('47%');
  fireEvent.keyDown(viewer, { key: '1' });
  expect(screen.getByRole('status')).toHaveTextContent('100%');
});
