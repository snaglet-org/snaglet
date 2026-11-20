import { render, waitFor, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// pdfjs + its worker asset are mocked: jsdom has no canvas 2d engine or worker,
// and we don't want to parse a real PDF — we assert the component's contract
// (fetch the raw endpoint, one canvas per page, loading/error states) with the
// pdf pipeline stubbed.
const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: {} as { workerSrc?: string },
}));

vi.mock('pdfjs-dist', () => ({
  getDocument: mocks.getDocument,
  GlobalWorkerOptions: mocks.GlobalWorkerOptions,
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'test-worker-url' }));

import { PdfViewer } from './PdfViewer';

function fakePdf(numPages: number) {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
    render: () => ({ promise: Promise.resolve() }),
  };
  return {
    numPages,
    getPage: vi.fn(async () => page),
    destroy: vi.fn(),
  };
}

/** Mirror pdfjs's getDocument() return shape: a loading task with a `.promise`
 * and a `.destroy()` the component calls on cleanup. */
function fakeLoadingTask(pdf: ReturnType<typeof fakePdf>) {
  return { promise: Promise.resolve(pdf), destroy: vi.fn() };
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  global.fetch = mockFetch;
  // jsdom's canvas has no 2d context; hand the render loop a minimal stub so it
  // runs instead of logging "not implemented".
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    scale: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  mocks.getDocument.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PdfViewer', () => {
  it('shows a loading state before the document resolves', () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
    render(<PdfViewer source={{ kind: 'id', fileId: 'file-1' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading PDF');
  });

  it('fetches the authenticated raw endpoint for an id source', () => {
    mockFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    mocks.getDocument.mockReturnValue(fakeLoadingTask(fakePdf(1)));

    render(<PdfViewer source={{ kind: 'id', fileId: 'file-abc' }} />);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/files/file-abc/raw'),
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('fetches the by-path raw endpoint for a path source', () => {
    mockFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    mocks.getDocument.mockReturnValue(fakeLoadingTask(fakePdf(1)));

    render(<PdfViewer source={{ kind: 'path', path: '/abs/paper.pdf' }} />);

    const [calledUrl] = mockFetch.mock.calls[0] as [string];
    expect(calledUrl).toContain('/api/files/raw?');
    expect(calledUrl).toContain('path=%2Fabs%2Fpaper.pdf');
  });

  it('renders one canvas per page once the document loads', async () => {
    mockFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    mocks.getDocument.mockReturnValue(fakeLoadingTask(fakePdf(3)));

    const { container } = render(<PdfViewer source={{ kind: 'id', fileId: 'file-1' }} />);

    await waitFor(() => {
      expect(container.querySelectorAll('canvas')).toHaveLength(3);
    });
  });

  it('shows an error when the raw fetch fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

    render(<PdfViewer source={{ kind: 'id', fileId: 'missing' }} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load PDF');
    });
  });

  it('destroys the pdf document on unmount', async () => {
    const pdf = fakePdf(1);
    mockFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    mocks.getDocument.mockReturnValue(fakeLoadingTask(pdf));

    const { container, unmount } = render(<PdfViewer source={{ kind: 'id', fileId: 'file-1' }} />);
    await waitFor(() => {
      expect(container.querySelectorAll('canvas')).toHaveLength(1);
    });

    unmount();
    expect(pdf.destroy).toHaveBeenCalled();
  });
});
