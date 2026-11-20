/**
 * Composer — the send path.
 *
 * Enter reaches `submit` without going through the Send button, so the
 * button's disabled state cannot be what keeps a send from going twice or
 * going without an image that is still uploading. And a send the server
 * rejects must come back as the user typed it, not as the wire text.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

// The real editor is irrelevant here; the mock shows the draft and exposes
// the editor's Enter-to-submit callback as a button.
vi.mock('@desktop/features/rich-markdown/editor/index.js', () => ({
  ChipEditableInput: ({ value, onSubmit }: { value: string; onSubmit?: () => void }) => (
    <div>
      <div data-testid="mock-rich-value">{value}</div>
      <button type="button" onClick={() => onSubmit?.()}>
        press enter
      </button>
    </div>
  ),
}));

vi.mock('@desktop/utils/api/images.js', () => ({
  imagesApi: { upload: vi.fn() },
  getImageContentUrl: (id: string) => `/api/images/${id}/content`,
}));

vi.mock('@desktop/utils/api/docs.js', () => ({
  docsApi: { get: vi.fn() },
}));

import { Composer } from './Composer';
import { imagesApi } from '@desktop/utils/api/images';
import { docsApi } from '@desktop/utils/api/docs';

const uploadMock = vi.mocked(imagesApi.upload);
const docGetMock = vi.mocked(docsApi.get);

type Upload = Awaited<ReturnType<typeof imagesApi.upload>>;
type Doc = Awaited<ReturnType<typeof docsApi.get>>;

function seedDraft(threadId: string, text: string) {
  localStorage.setItem(`snaglet:chat-draft:${threadId}`, JSON.stringify({ text }));
}

function dropImage(name: string) {
  const composer = screen.getByTestId('message-composer');
  const files = [new File(['content'], name, { type: 'image/png' })];
  const dataTransfer = { types: ['Files'], files } as unknown as DataTransfer;
  fireEvent.dragEnter(composer, { dataTransfer });
  fireEvent.drop(composer, { dataTransfer });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: vi.fn(() => 'blob:test-preview') },
    revokeObjectURL: { configurable: true, value: vi.fn() },
  });
  uploadMock.mockReset();
  docGetMock.mockReset();
  localStorage.clear();
});

describe('Composer — Enter while a send is still being prepared', () => {
  it('sends once when Enter is pressed again while a doc include is still expanding', async () => {
    const doc = deferred<Doc>();
    docGetMock.mockReturnValue(doc.promise);
    const onSubmit = vi.fn();
    seedDraft('thread-include', 'See ![](doc-1111111111111-aaaaaaaaa)');
    render(<Composer threadId="thread-include" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'press enter' }));
    fireEvent.click(screen.getByRole('button', { name: 'press enter' }));
    await act(async () => {
      doc.resolve({ title: 'Doc A', content: 'Included body' } as Doc);
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(docGetMock).toHaveBeenCalledTimes(1);
  });

  it('holds Enter while an image is uploading, then sends it with the image', async () => {
    const upload = deferred<Upload>();
    uploadMock.mockReturnValue(upload.promise);
    const onSubmit = vi.fn();
    seedDraft('thread-upload', 'Look at this');
    render(<Composer threadId="thread-upload" onSubmit={onSubmit} />);

    dropImage('shot.png');
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'press enter' }));
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => {
      upload.resolve({ id: 'img-1' } as Upload);
    });
    await screen.findByAltText('shot.png');
    fireEvent.click(screen.getByRole('button', { name: 'press enter' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('Look at this\n\n<image id="img-1"/>');
  });
});

describe('Composer — restoring a failed send', () => {
  it('puts back the typed draft and its images, not the outbound wire text', async () => {
    uploadMock.mockResolvedValue({ id: 'img-1' } as Upload);
    docGetMock.mockResolvedValue({ title: 'Doc A', content: 'Included body' } as Doc);
    const onSubmit = vi.fn();
    const onRestored = vi.fn();
    const draft = 'See ![](doc-1111111111111-aaaaaaaaa)';
    seedDraft('thread-restore', draft);
    const { rerender } = render(
      <Composer threadId="thread-restore" onSubmit={onSubmit} onRestored={onRestored} />
    );

    dropImage('shot.png');
    await screen.findByAltText('shot.png');
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const outbound = onSubmit.mock.calls[0]![0] as string;
    expect(outbound).toContain('<doc id="doc-1111111111111-aaaaaaaaa"');
    expect(outbound).toContain('<image id="img-1"/>');
    await waitFor(() => expect(screen.queryByAltText('shot.png')).not.toBeInTheDocument());
    expect(screen.getByTestId('mock-rich-value')).toHaveTextContent('');

    rerender(
      <Composer
        threadId="thread-restore"
        onSubmit={onSubmit}
        onRestored={onRestored}
        restoreText={outbound}
      />
    );

    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('mock-rich-value').textContent).toBe(draft);
    expect(screen.getByRole('img', { name: 'shot.png preview unavailable' })).toBeInTheDocument();
  });

  it('restores text it did not send itself as given', async () => {
    const onRestored = vi.fn();
    const { rerender } = render(
      <Composer threadId="thread-foreign" onSubmit={vi.fn()} onRestored={onRestored} />
    );

    rerender(
      <Composer
        threadId="thread-foreign"
        onSubmit={vi.fn()}
        onRestored={onRestored}
        restoreText="Sent from elsewhere"
      />
    );

    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('mock-rich-value').textContent).toBe('Sent from elsewhere');
  });
});

describe('Composer — the attach-image picker', () => {
  it('says which picked files were skipped because they are not images', async () => {
    uploadMock.mockResolvedValue({ id: 'img-1' } as Upload);
    const { container } = render(<Composer threadId="thread-picker" onSubmit={vi.fn()} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    fireEvent.change(input, {
      target: {
        files: [
          new File(['content'], 'shot.png', { type: 'image/png' }),
          new File(['content'], 'notes.pdf', { type: 'application/pdf' }),
        ],
      },
    });

    expect(screen.getByRole('status')).toHaveTextContent(
      'Only images can be attached; skipped "notes.pdf".'
    );
    await screen.findByAltText('shot.png');
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });
});
