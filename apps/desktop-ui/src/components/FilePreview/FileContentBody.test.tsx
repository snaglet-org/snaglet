import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileContent } from '@desktop/utils/api';
import { FileContentBody } from './FileContentBody';

// The PDF branch is PdfViewer's own suite; a stub keeps pdfjs out of this one.
vi.mock('./PdfViewer', () => ({
  PdfViewer: () => <div data-testid="pdf-viewer" />,
}));

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn(() => new Promise(() => {}));
  global.fetch = mockFetch;
});

/** What the text routes answer for an audio file: never previewable. */
function binary(relativePath: string, reason: FileContent['reason'] = 'binary'): FileContent {
  return { id: 'file-1', relativePath, sizeBytes: 4096, content: null, previewable: false, reason };
}

describe('FileContentBody audio branch', () => {
  it.each(['show.mp3', 'show.wav', 'show.m4a', 'show.ogg', 'SHOW.MP3'])(
    'plays %s instead of the not-text notice',
    (fileName) => {
      render(
        <FileContentBody
          data={binary(fileName)}
          fileName={fileName}
          rawSource={{ kind: 'id', fileId: 'file-1' }}
        />
      );
      expect(screen.getByRole('status')).toHaveTextContent('Loading audio');
      expect(screen.queryByText(/not text/)).toBeNull();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/files/file-1/raw'),
        expect.objectContaining({ method: 'GET' })
      );
    }
  );

  it('routes a path source to the by-path raw endpoint, even when the text route said too_large', () => {
    const path = '/projects/example/episodes/2026-01-01/show.mp3';
    render(
      <FileContentBody
        data={binary('show.mp3', 'too_large')}
        fileName="show.mp3"
        rawSource={{ kind: 'path', path }}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading audio');
    const [calledUrl] = mockFetch.mock.calls[0] as [string];
    expect(calledUrl).toContain(`/api/files/raw?${new URLSearchParams({ path }).toString()}`);
  });

  it('labels the player with the base name of a nested relative path', () => {
    render(
      <FileContentBody
        data={binary('episodes/2026-01-01/show.mp3')}
        fileName="episodes/2026-01-01/show.mp3"
        rawSource={{ kind: 'path', path: '/projects/example/episodes/2026-01-01/show.mp3' }}
      />
    );
    expect(screen.getByText('show.mp3')).toBeInTheDocument();
  });

  it('keeps the not-text notice for audio when no raw source is known', () => {
    render(<FileContentBody data={binary('show.mp3')} fileName="show.mp3" />);
    expect(screen.getByText('This file is not text and cannot be previewed.')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('keeps the not-text notice for other binary files', () => {
    render(
      <FileContentBody
        data={binary('archive.zip')}
        fileName="archive.zip"
        rawSource={{ kind: 'id', fileId: 'file-1' }}
      />
    );
    expect(screen.getByText('This file is not text and cannot be previewed.')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('still routes a PDF to the PDF viewer', () => {
    render(
      <FileContentBody
        data={binary('paper.pdf')}
        fileName="paper.pdf"
        rawSource={{ kind: 'id', fileId: 'file-1' }}
      />
    );
    expect(screen.getByTestId('pdf-viewer')).toBeInTheDocument();
  });
});
