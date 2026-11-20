import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileMarkdownPreview, isRelativeFileUrl } from './FileMarkdownPreview';
import { getRelativeFile } from '@desktop/utils/api/files';
vi.mock('@desktop/utils/api/files', () => ({
  getRelativeFile: vi.fn(),
  relativeFileUrl: () => '/api/files/relative',
}));
vi.mock('./PdfViewer', () => ({ PdfViewer: () => null }));
vi.mock('@desktop/features/rich-markdown/editor/agentMentionCache', () => ({
  ensureAgents: vi.fn(),
  getAgentsCached: () => [],
}));
const data = {
  id: 'file-source',
  relativePath: 'readme.md',
  sizeBytes: 10,
  previewable: true,
  content:
    '[Sibling](other.md)\n\n[External](https://example.com)\n\n[Anchor](#heading)\n\n# Heading',
};
describe('file Markdown navigation', () => {
  it('scrolls local and linked heading fragments inside the preview', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    vi.mocked(getRelativeFile).mockResolvedValue({
      ...data,
      id: '/project/other.md',
      relativePath: 'other.md',
      content: '# Destination',
    });
    render(
      <FileMarkdownPreview
        source="file-source"
        data={{
          ...data,
          content: '[Here](#heading)\n\n# Heading\n\n[There](other.md#destination)',
        }}
      />
    );
    fireEvent.click(screen.getByRole('link', { name: 'Here' }));
    expect(scroll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('link', { name: 'There' }));
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
  });
  beforeEach(() => vi.clearAllMocks());
  it('keeps external URLs and anchors distinct from local paths', () => {
    expect(isRelativeFileUrl('../docs/a.md')).toBe(true);
    expect(isRelativeFileUrl('#heading')).toBe(false);
    expect(isRelativeFileUrl('https://example.com')).toBe(false);
    expect(isRelativeFileUrl('//example.com/a')).toBe(false);
  });
  it('opens a relative document in the preview and returns with Back', async () => {
    vi.mocked(getRelativeFile).mockResolvedValue({
      ...data,
      id: '/project/other.md',
      relativePath: 'other.md',
      content: '# Sibling body',
    });
    render(<FileMarkdownPreview data={data} source="file-source" />);
    expect(screen.getByRole('link', { name: 'External' })).toHaveAttribute(
      'href',
      'https://example.com'
    );
    expect(screen.getByRole('link', { name: 'Anchor' })).not.toHaveAttribute('target');
    fireEvent.click(screen.getByRole('link', { name: 'Sibling' }));
    expect(await screen.findByRole('heading', { name: 'Sibling body' })).toBeInTheDocument();
    expect(getRelativeFile).toHaveBeenCalledWith('file-source', 'other.md', undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Back to readme.md' }));
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
  });
  it('keeps the source visible with a useful error when a link is unavailable', async () => {
    vi.mocked(getRelativeFile).mockRejectedValue(
      new Error('Linked file is missing or outside the project folder')
    );
    render(<FileMarkdownPreview data={data} source="file-source" />);
    fireEvent.click(screen.getByRole('link', { name: 'Sibling' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('missing or outside'));
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
  });
});

describe('local Markdown images', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('uses authenticated fetch, then releases its blob URL on unmount', async () => {
    const revoke = vi.fn();
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:local-image'),
        revokeObjectURL: revoke,
      })
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'Content-Type': 'image/png' }),
      blob: async () => new Blob(['png']),
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = render(
      <FileMarkdownPreview
        source="file-source"
        data={{ ...data, content: '![Sibling picture](./image.png)' }}
      />
    );
    expect(await screen.findByRole('img', { name: 'Sibling picture' })).toHaveAttribute(
      'src',
      'blob:local-image'
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/files/relative',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    view.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:local-image');
  });
  it('shows a useful missing-image state without a broken network URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    render(
      <FileMarkdownPreview
        source="file-source"
        data={{ ...data, content: '![Missing picture](./missing.png)' }}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Image unavailable: Missing picture')
    );
    expect(screen.queryByRole('img')).toBeNull();
  });
});
