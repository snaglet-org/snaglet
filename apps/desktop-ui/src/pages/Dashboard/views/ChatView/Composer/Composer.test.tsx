/**
 * Composer: dropped-file behavior. An image drop uploads and embeds as an
 * attachment; a non-image drop resolves an absolute path (unique, ambiguous
 * or not found) via `resolveDroppedFilePath`. That function is tested in
 * `@desktop/utils/dropPathRecovery/resolveDroppedFilePath.test.ts`; here only
 * Composer's reaction to each outcome is checked.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// @desktop/components pulls in the real API config module, which throws at
// import time if VITE_API_BASE_URL/VITE_APP_NAME are unset. vi.hoisted runs
// this above the vi.mock factories and the static imports.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

// The real ChipEditableInput mounts a full TipTap/ProseMirror editor — heavy
// and irrelevant here, since every drop under test lands on the composer's
// own wrap div, not inside the editor. Mirrors WorkspaceEditor.test.tsx's
// mock of the same component.
vi.mock('@desktop/features/rich-markdown/editor/index.js', () => ({
  ChipEditableInput: ({ value }: { value: string }) => (
    <div data-testid="mock-rich-value">{value}</div>
  ),
}));

vi.mock('@desktop/utils/api/images.js', () => ({
  imagesApi: { upload: vi.fn() },
  getImageContentUrl: (id: string) => `/api/images/${id}/content`,
}));

vi.mock('@desktop/utils/dropPathRecovery/index.js', () => ({
  resolveDroppedFilePath: vi.fn(),
}));

import { Composer } from './Composer';
import { imagesApi } from '@desktop/utils/api/images';
import { resolveDroppedFilePath } from '@desktop/utils/dropPathRecovery';
import { ThreadRecipientProvider } from '@desktop/features/voice/ThreadRecipientContext';
import { AgentPillsRow } from '@desktop/features/voice/components/AgentPillsRow';

const uploadMock = vi.mocked(imagesApi.upload);
const resolveMock = vi.mocked(resolveDroppedFilePath);

const MB = 1024 * 1024;

function makeFile(name: string, type: string): File {
  return new File(['content'], name, { type });
}

/** A `File` that reports `size` bytes without holding them. */
function sizedFile(name: string, type: string, size: number): File {
  const file = makeFile(name, type);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function dropFiles(files: File[], directoryNames: string[] = []) {
  const composer = screen.getByTestId('message-composer');
  const items = files.map((f) => ({
    kind: 'file',
    webkitGetAsEntry: () => ({ name: f.name, isDirectory: directoryNames.includes(f.name) }),
  }));
  const dataTransfer = { types: ['Files'], files, items } as unknown as DataTransfer;
  fireEvent.dragEnter(composer, { dataTransfer });
  fireEvent.drop(composer, { dataTransfer });
}

/** Seed the composer's persisted draft the same way useDraftPersistence
 *  reads it on mount, so a test can start with non-empty text without
 *  driving the (mocked, non-interactive) rich editor. */
function seedDraft(threadId: string, text: string) {
  localStorage.setItem(`snaglet:chat-draft:${threadId}`, JSON.stringify({ text }));
}

beforeEach(() => {
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: vi.fn(() => 'blob:test-preview') },
    revokeObjectURL: { configurable: true, value: vi.fn() },
  });
  uploadMock.mockReset();
  resolveMock.mockReset();
  localStorage.clear();
});

describe('Composer — primary bubble and secondary controls hierarchy', () => {
  it('keeps only Upload, Stop, and Send actions inside the bordered bubble', () => {
    seedDraft('thread-layout', 'ready to send');
    render(
      <Composer
        threadId="thread-layout"
        onSubmit={vi.fn()}
        working
        onStop={vi.fn()}
        voiceControls={<span>Dictation sentinel</span>}
        voiceModeControls={<span>Voice and Vision sentinel</span>}
      />
    );

    const bubble = screen.getByTestId('message-composer');
    const rail = screen.getByTestId('composer-secondary-rail');
    expect(rail).toHaveRole('group');
    expect(rail).toHaveAttribute('aria-label', 'Composer secondary controls');
    expect(within(bubble).getByLabelText('Attach image')).toBeInTheDocument();
    expect(within(bubble).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(within(bubble).getByLabelText('Send message')).toBeInTheDocument();
    expect(within(bubble).queryByText('Dictation sentinel')).not.toBeInTheDocument();
    expect(within(bubble).queryByText('Voice and Vision sentinel')).not.toBeInTheDocument();

    expect(within(rail).getByText('Dictation sentinel')).toBeInTheDocument();
    expect(within(rail).getByText('Voice and Vision sentinel')).toBeInTheDocument();
    expect(within(rail).queryByLabelText('Attach image')).not.toBeInTheDocument();
    expect(within(rail).queryByLabelText('Send message')).not.toBeInTheDocument();
    expect(bubble.parentElement).toBe(rail.parentElement);
    expect(bubble.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('Composer — chat newline submit boundary', () => {
  it('sends Shift+Enter hard breaks as newline bytes, not visible CommonMark backslashes', async () => {
    const onSubmit = vi.fn();
    seedDraft('thread-newline', 'line one\\\nline two');
    render(<Composer threadId="thread-newline" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two');
    expect(onSubmit.mock.calls[0][0]).not.toContain('\\\n');
  });

  it('preserves an intentional literal backslash before a Shift+Enter newline', async () => {
    const onSubmit = vi.fn();
    seedDraft('thread-literal-backslash', `literal${'\\'.repeat(3)}\nnext`);
    render(<Composer threadId="thread-literal-backslash" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(`literal${'\\'}\nnext`);
  });

  it('keeps paragraph breaks distinct from Shift+Enter hard breaks', async () => {
    const onSubmit = vi.fn();
    seedDraft('thread-paragraph-breaks', 'first paragraph\n\nsecond paragraph');
    render(<Composer threadId="thread-paragraph-breaks" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('first paragraph\n\nsecond paragraph');
  });
});

describe('Composer — shared recipient pills', () => {
  const participantAgentIds = ['agent-venus', 'agent-clio'];
  const agentNameById = new Map([
    ['agent-venus', 'Venus'],
    ['agent-clio', 'Clio'],
  ]);

  function renderRecipients(threadId: string, text: string, onSubmit: (value: string) => void) {
    seedDraft(threadId, text);
    return render(
      <ThreadRecipientProvider
        threadId={threadId}
        messages={[]}
        participantAgentIds={participantAgentIds}
        agentNameById={agentNameById}
      >
        <AgentPillsRow />
        <Composer threadId={threadId} onSubmit={onSubmit} />
      </ThreadRecipientProvider>
    );
  }

  it('shows group recipients with voice off and appends every selected agent to a typed send', async () => {
    const onSubmit = vi.fn();
    renderRecipients('thread-recipients', 'Hello team', onSubmit);

    const group = screen.getByRole('group', { name: 'Message recipients' });
    fireEvent.click(within(group).getByRole('button', { name: 'Venus' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Clio' }));
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('Hello team @Venus @Clio');
  });

  it('does not duplicate a selected agent the user already mentioned', async () => {
    const onSubmit = vi.fn();
    renderRecipients('thread-recipient-dedupe', 'Hello @Venus', onSubmit);

    const group = screen.getByRole('group', { name: 'Message recipients' });
    fireEvent.click(within(group).getByRole('button', { name: 'Venus' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Clio' }));
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('Hello @Venus @Clio');
  });

  it('deliberately leaves typed text unaddressed when every pill is deselected', async () => {
    const onSubmit = vi.fn();
    renderRecipients('thread-no-recipients', 'No recipient chosen', onSubmit);

    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('No recipient chosen');
  });

  it('does not append the invisible voice default target in a solo thread', async () => {
    const onSubmit = vi.fn();
    seedDraft('thread-solo', 'Hello solo agent');
    render(
      <ThreadRecipientProvider
        threadId="thread-solo"
        messages={[]}
        participantAgentIds={['agent-venus']}
        agentNameById={agentNameById}
      >
        <AgentPillsRow />
        <Composer threadId="thread-solo" onSubmit={onSubmit} />
      </ThreadRecipientProvider>
    );

    expect(screen.queryByRole('group', { name: 'Message recipients' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('Hello solo agent');
  });
});

describe('Composer — image drop', () => {
  it('uploads and shows the image as an attachment, without ever consulting path-recovery', async () => {
    uploadMock.mockResolvedValue({ id: 'img-1' } as Awaited<ReturnType<typeof imagesApi.upload>>);
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('photo.png', 'image/png')]);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText('Attached images')).toBeInTheDocument();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('shows a dropped image through a local blob URL rather than the protected content route', async () => {
    const createObjectURL = vi.mocked(URL.createObjectURL);
    createObjectURL.mockReturnValue('blob:photo-preview');
    uploadMock.mockResolvedValue({ id: 'img-1' } as Awaited<ReturnType<typeof imagesApi.upload>>);
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('photo.png', 'image/png')]);

    const preview = await screen.findByRole('img', { name: 'photo.png' });
    expect(preview).toHaveAttribute('src', 'blob:photo-preview');
    expect(preview).not.toHaveAttribute('src', '/api/images/img-1/content');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('uses the same local preview for the file picker', async () => {
    uploadMock.mockResolvedValue({ id: 'img-1' } as Awaited<ReturnType<typeof imagesApi.upload>>);
    render(<Composer onSubmit={vi.fn()} />);

    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [makeFile('picked.png', 'image/png')] },
    });

    expect(await screen.findByRole('img', { name: 'picked.png' })).toHaveAttribute(
      'src',
      'blob:test-preview'
    );
  });

  it('revokes local previews after sending the attachment', async () => {
    const onSubmit = vi.fn();
    uploadMock.mockResolvedValue({ id: 'img-1' } as Awaited<ReturnType<typeof imagesApi.upload>>);
    const revokeObjectURL = vi.mocked(URL.revokeObjectURL);
    render(<Composer onSubmit={onSubmit} />);

    dropFiles([makeFile('photo.png', 'image/png')]);
    await screen.findByRole('img', { name: 'photo.png' });
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('<image id="img-1"/>'));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-preview');
  });

  it('revokes a local preview when its attachment is removed', async () => {
    uploadMock.mockResolvedValue({ id: 'img-1' } as Awaited<ReturnType<typeof imagesApi.upload>>);
    const revokeObjectURL = vi.mocked(URL.revokeObjectURL);
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('photo.png', 'image/png')]);
    fireEvent.click(await screen.findByLabelText('Remove photo.png'));

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-preview');
  });

  it('accepts a pasted image and uses the same local preview path', async () => {
    uploadMock.mockResolvedValue({ id: 'img-1' } as Awaited<ReturnType<typeof imagesApi.upload>>);
    render(<Composer onSubmit={vi.fn()} />);

    fireEvent.paste(screen.getByTestId('message-composer'), {
      clipboardData: { files: [makeFile('pasted.png', 'image/png')] },
    });

    expect(await screen.findByRole('img', { name: 'pasted.png' })).toHaveAttribute(
      'src',
      'blob:test-preview'
    );
  });

  it('sends the THREAD id and never a container', async () => {
    // Placement is the server's decision. If the client sent a containerId it
    // would be asserting a container it may have cached before a move, and
    // the endpoint rejects both fields together — so this must be threadId
    // only, not threadId plus a "helpful" container.
    uploadMock.mockResolvedValue({ id: 'img-1' } as Awaited<ReturnType<typeof imagesApi.upload>>);
    render(<Composer onSubmit={vi.fn()} threadId="thread-42" />);

    dropFiles([makeFile('photo.png', 'image/png')]);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    const body = uploadMock.mock.calls[0][0];
    expect(body.threadId).toBe('thread-42');
    expect(body).not.toHaveProperty('containerId');
    // Bytes and name are untouched by the placement change.
    expect(body.dataUrl).toMatch(/^data:image\/png/);
    expect(body.name).toBe('photo.png');
  });

  it('omits threadId entirely when the composer has no thread', async () => {
    // A thread-less composer must not send `threadId: undefined` — the server
    // treats presence as "resolve by thread", and an absent thread is a
    // plain workspace upload.
    uploadMock.mockResolvedValue({ id: 'img-1' } as Awaited<ReturnType<typeof imagesApi.upload>>);
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('photo.png', 'image/png')]);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock.mock.calls[0][0]).not.toHaveProperty('threadId');
  });

  it('uses the CURRENT thread after a switch, not the one it first rendered with', async () => {
    // The upload callback closes over threadId; without it in the dependency
    // list a reused Composer would keep uploading into the previous thread's
    // container, silently and successfully.
    uploadMock.mockResolvedValue({ id: 'img-1' } as Awaited<ReturnType<typeof imagesApi.upload>>);
    const { rerender } = render(<Composer onSubmit={vi.fn()} threadId="thread-old" />);
    rerender(<Composer onSubmit={vi.fn()} threadId="thread-new" />);

    dropFiles([makeFile('photo.png', 'image/png')]);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock.mock.calls[0][0].threadId).toBe('thread-new');
  });

  it('uploads a 9 MB image', async () => {
    uploadMock.mockResolvedValue({ id: 'img-1' } as Awaited<ReturnType<typeof imagesApi.upload>>);
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([sizedFile('large.png', 'image/png', 9 * MB)]);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refuses an image over 50 MB with the limit and sends nothing', async () => {
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([sizedFile('huge.png', 'image/png', 72 * MB)]);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This image is 72 MB. Images can be up to 50 MB.'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(/upload failed/i);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('refuses a pasted image over 50 MB the same way', async () => {
    render(<Composer onSubmit={vi.fn()} />);

    fireEvent.paste(screen.getByTestId('message-composer'), {
      clipboardData: { files: [sizedFile('pasted.png', 'image/png', 51 * MB)] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This image is 51 MB. Images can be up to 50 MB.'
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('uploads the images that fit and names the one that does not', async () => {
    uploadMock.mockResolvedValue({ id: 'img-1' } as Awaited<ReturnType<typeof imagesApi.upload>>);
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([sizedFile('huge.png', 'image/png', 72 * MB), makeFile('small.png', 'image/png')]);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock.mock.calls[0][0].name).toBe('small.png');
    expect(await screen.findByRole('img', { name: 'small.png' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      '"huge.png" is 72 MB. Images can be up to 50 MB.'
    );
  });

  it('still says when an upload fails on the server', async () => {
    uploadMock.mockRejectedValue(new Error('Thread not found'));
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('photo.png', 'image/png')]);

    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed: Thread not found');
  });

  it('multiple images upload the same way as a single image (no path-recovery involvement)', async () => {
    uploadMock
      .mockResolvedValueOnce({ id: 'img-1' } as Awaited<ReturnType<typeof imagesApi.upload>>)
      .mockResolvedValueOnce({ id: 'img-2' } as Awaited<ReturnType<typeof imagesApi.upload>>);
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('a.png', 'image/png'), makeFile('b.jpg', 'image/jpeg')]);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));
    expect(resolveMock).not.toHaveBeenCalled();
  });
});

describe('Composer — non-image drop (Spotlight path-recovery)', () => {
  it('unique resolution: inserts the absolute path into the composer', async () => {
    resolveMock.mockResolvedValue({ status: 'unique', path: '/Users/user/notes.txt' });
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('notes.txt', 'text/plain')]);

    await waitFor(() => expect(resolveMock).toHaveBeenCalledTimes(1));
    const [passedFile] = resolveMock.mock.calls[0];
    expect(passedFile.name).toBe('notes.txt');

    await waitFor(() =>
      expect(screen.getByTestId('mock-rich-value').textContent).toBe('/Users/user/notes.txt')
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('ambiguous resolution: shows a picker; choosing a candidate inserts it and closes the picker', async () => {
    resolveMock.mockResolvedValue({
      status: 'ambiguous',
      candidates: ['/a/notes.txt', '/b/notes.txt'],
    });
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('notes.txt', 'text/plain')]);

    const optionA = await screen.findByRole('option', { name: '/a/notes.txt' });
    expect(screen.getByRole('option', { name: '/b/notes.txt' })).toBeInTheDocument();

    fireEvent.mouseDown(optionA);

    await waitFor(() =>
      expect(screen.getByTestId('mock-rich-value').textContent).toBe('/a/notes.txt')
    );
    expect(screen.queryByRole('option', { name: '/b/notes.txt' })).not.toBeInTheDocument();
  });

  it('ambiguous resolution: dismissing the picker leaves the composer unchanged', async () => {
    resolveMock.mockResolvedValue({
      status: 'ambiguous',
      candidates: ['/a/notes.txt', '/b/notes.txt'],
    });
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('notes.txt', 'text/plain')]);

    await screen.findByRole('option', { name: '/a/notes.txt' });
    fireEvent.mouseDown(screen.getByText('Cancel'));

    await waitFor(() =>
      expect(screen.queryByRole('option', { name: '/a/notes.txt' })).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('mock-rich-value').textContent).toBe('');
  });

  it('not-found resolution: shows an unobtrusive notice and leaves the composer unchanged', async () => {
    resolveMock.mockResolvedValue({ status: 'not_found' });
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('mystery.bin', 'application/octet-stream')]);

    expect(await screen.findByRole('status')).toHaveTextContent(/couldn.t locate/i);
    expect(screen.getByTestId('mock-rich-value').textContent).toBe('');
  });

  it('a not-found notice does not linger into a later, successful drop', async () => {
    resolveMock.mockResolvedValueOnce({ status: 'not_found' });
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('mystery.bin', 'application/octet-stream')]);
    await screen.findByRole('status');

    resolveMock.mockResolvedValueOnce({ status: 'unique', path: '/found/it.txt' });
    dropFiles([makeFile('it.txt', 'text/plain')]);

    await waitFor(() =>
      expect(screen.getByTestId('mock-rich-value').textContent).toBe('/found/it.txt')
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('a dropped folder is tagged isDirectory and its path is inserted', async () => {
    resolveMock.mockResolvedValue({ status: 'unique', path: '/Users/user/Projects/overlay-lab' });
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('overlay-lab', '')], ['overlay-lab']);

    await waitFor(() => expect(resolveMock).toHaveBeenCalledTimes(1));
    const [passedFile, options] = resolveMock.mock.calls[0];
    expect(passedFile.name).toBe('overlay-lab');
    expect(options).toEqual({ isDirectory: true });
    await waitFor(() =>
      expect(screen.getByTestId('mock-rich-value').textContent).toBe(
        '/Users/user/Projects/overlay-lab'
      )
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('a regular file is not tagged as a directory', async () => {
    resolveMock.mockResolvedValue({ status: 'unique', path: '/Users/user/notes.txt' });
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('notes.txt', 'text/plain')]);

    await waitFor(() => expect(resolveMock).toHaveBeenCalledTimes(1));
    expect(resolveMock.mock.calls[0][1]).toEqual({ isDirectory: false });
  });

  it('a mixed drop uploads the image and resolves the non-image independently', async () => {
    uploadMock.mockResolvedValue({ id: 'img-1' } as Awaited<ReturnType<typeof imagesApi.upload>>);
    resolveMock.mockResolvedValue({ status: 'unique', path: '/x/doc.pdf' });
    render(<Composer onSubmit={vi.fn()} />);

    dropFiles([makeFile('photo.png', 'image/png'), makeFile('doc.pdf', 'application/pdf')]);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('mock-rich-value').textContent).toBe('/x/doc.pdf')
    );
  });
});
