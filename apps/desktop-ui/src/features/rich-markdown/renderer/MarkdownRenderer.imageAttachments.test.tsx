import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/features/rich-markdown/preview/WikiLinkPreviewModal', () => ({
  WikiLinkPreviewModal: ({
    kind,
    id,
    onClose,
  }: {
    kind: string;
    id: string;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label={`preview ${kind} ${id}`}>
      <button onClick={onClose}>close</button>
    </div>
  ),
}));

import { MarkdownRenderer } from './MarkdownRenderer';

const IMAGE_ID = 'image-1111111111111-mkzahe3ag';

describe('MarkdownRenderer image attachments', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // MarkdownRenderer must render stored images through the authenticated
    // fetch→blob path (useAuthenticatedImage), NOT a raw `<img src=…/content>`.
    // A native <img> element load bypasses the wrapped window.fetch that
    // attaches x-snaglet-token, so in packaged builds (SNAGLET_AUTH_TOKEN set) the
    // sidecar 401s the request and the image never renders. We mock
    // fetch + URL.createObjectURL to observe the auth path is taken.
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['mock'], { type: 'image/png' }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    let created = 0;
    global.URL.createObjectURL = vi.fn(() => `blob:mock-${created++}`);
    global.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an image-node attachment link via the authenticated blob path', async () => {
    render(<MarkdownRenderer content={`[preview.png](${IMAGE_ID})`} showIncludeToggle={false} />);

    // The image resolves to a blob: URL (produced by the wrapped fetch),
    // never a raw /api/.../content element load.
    const img = await screen.findByRole('img', { name: 'preview.png' });
    expect(img.getAttribute('src')).toMatch(/^blob:/);

    // Regression guard: the fix is defined by the fetch being made through the
    // wrapped window.fetch (which attaches auth). A raw <img src> would make
    // zero fetch calls — that is exactly the packaged-app 401 bug.
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/images/${IMAGE_ID}/content`,
        expect.objectContaining({ method: 'GET' })
      )
    );
  });

  it('renders an image marker as an accessible inline image preview via blob', async () => {
    render(<MarkdownRenderer content={`<image id="${IMAGE_ID}"/>`} showIncludeToggle={false} />);

    const img = await screen.findByRole('img', { name: 'Attached image' });
    expect(img.getAttribute('src')).toMatch(/^blob:/);
  });

  it('never emits a raw token-less <img src="/api/…/content"> element', async () => {
    const { container } = render(
      <MarkdownRenderer content={`[preview.png](${IMAGE_ID})`} showIncludeToggle={false} />
    );

    await screen.findByRole('img', { name: 'preview.png' });

    // No <img> in the tree may point directly at the raw content endpoint —
    // that native load carries no x-snaglet-token and 401s in packaged builds.
    const rawImg = container.querySelector('img[src*="/api/images/"]');
    expect(rawImg).toBeNull();
  });

  it('lifts a link-form stored image out of its paragraph (no <div> inside <p>)', async () => {
    // AuthenticatedImageContent renders block-level <div role="status"> in its
    // loading/error states. remarkLiftImageParagraphs must lift the link-form
    // `[name](image-…)` node out of the surrounding <p> — a <div> nested in a
    // <p> is invalid HTML and React 19 surfaces it as a hydration error. The
    // native <img> was p-valid, so this guard is specific to routing stored
    // images through the block component.
    const { container } = render(
      <MarkdownRenderer content={`[preview.png](${IMAGE_ID})`} showIncludeToggle={false} />
    );

    const img = await screen.findByRole('img', { name: 'preview.png' });
    // No ancestor <p> wraps the lifted image — it sits as a block sibling.
    expect(img.closest('p')).toBeNull();
    // And no <p> in the tree contains a block-level <div> (the invalid nesting).
    for (const p of Array.from(container.querySelectorAll('p'))) {
      expect(p.querySelector('div')).toBeNull();
    }
  });

  it('keeps a non-image file attachment in the generic file-chip path', () => {
    const { container } = render(
      <MarkdownRenderer content="[report.pdf](file:reports/report.pdf)" showIncludeToggle={false} />
    );

    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('[data-node-kind="file"]')).toHaveTextContent('report.pdf');
  });

  it('wraps a stored image in a node link that opens the image preview modal', async () => {
    render(<MarkdownRenderer content={`<image id="${IMAGE_ID}"/>`} showIncludeToggle={false} />);

    const img = await screen.findByRole('img', { name: 'Attached image' });
    const link = img.closest('a');
    expect(link).toHaveAttribute('data-node-kind', 'image');
    expect(link).toHaveAttribute('data-node-id', IMAGE_ID);

    fireEvent.click(img);
    expect(await screen.findByRole('dialog', { name: `preview image ${IMAGE_ID}` })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
