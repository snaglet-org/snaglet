import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer } from './AudioPlayer';

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let mockFetch: ReturnType<typeof vi.fn>;
let created: string[];
let revoked: string[];

/** The player's `<audio>` element once the bytes have loaded. */
function findAudio(container: HTMLElement): Promise<HTMLAudioElement> {
  return waitFor(() => {
    const audio = container.querySelector('audio');
    if (!audio) throw new Error('audio element not rendered yet');
    return audio;
  });
}

function okAudio(): Partial<Response> {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    blob: async () => new Blob(['audio-bytes'], { type: 'audio/mpeg' }),
  };
}

beforeEach(() => {
  mockFetch = vi.fn();
  global.fetch = mockFetch;
  created = [];
  revoked = [];
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test-${created.length}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  // Unmount while the URL stubs exist: the player revokes its URL on unmount.
  cleanup();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.restoreAllMocks();
});

describe('AudioPlayer', () => {
  it('shows the file name and a loading state before the bytes arrive', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<AudioPlayer source={{ kind: 'id', fileId: 'file-1' }} fileName="show.mp3" />);
    expect(screen.getByText('show.mp3')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading audio');
  });

  it('fetches the authenticated raw endpoint for an id source', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<AudioPlayer source={{ kind: 'id', fileId: 'file-abc' }} fileName="show.mp3" />);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/files/file-abc/raw'),
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('fetches the by-path raw endpoint for a path source', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(
      <AudioPlayer
        source={{ kind: 'path', path: '/projects/example/episodes/show.mp3' }}
        fileName="show.mp3"
      />
    );
    const [calledUrl] = mockFetch.mock.calls[0] as [string];
    expect(calledUrl).toContain('/api/files/raw?');
    expect(calledUrl).toContain('path=%2Fprojects%2Fexample%2Fepisodes%2Fshow.mp3');
  });

  it('plays the fetched bytes from a blob URL through a native control', async () => {
    mockFetch.mockResolvedValue(okAudio());
    const { container } = render(
      <AudioPlayer source={{ kind: 'id', fileId: 'file-1' }} fileName="show.mp3" />
    );

    const audio = await findAudio(container);
    expect(audio).toHaveAttribute('src', 'blob:test-0');
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAccessibleName('Play show.mp3');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('revokes the blob URL on unmount', async () => {
    mockFetch.mockResolvedValue(okAudio());
    const { container, unmount } = render(
      <AudioPlayer source={{ kind: 'id', fileId: 'file-1' }} fileName="show.mp3" />
    );
    await findAudio(container);

    unmount();
    expect(revoked).toEqual(['blob:test-0']);
  });

  it('says the file is too large to play when the raw route answers 413', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 413, statusText: 'Payload Too Large' });
    const { container } = render(
      <AudioPlayer
        source={{ kind: 'path', path: '/projects/example/long.wav' }}
        fileName="long.wav"
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('This file is too large to play here.');
    });
    expect(container.querySelector('audio')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('shows an error when the raw fetch fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    const { container } = render(
      <AudioPlayer source={{ kind: 'id', fileId: 'missing' }} fileName="show.mp3" />
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load audio: 404 Not Found');
    });
    expect(container.querySelector('audio')).toBeNull();
  });

  it('replaces the control with a message when the webview cannot decode the file', async () => {
    mockFetch.mockResolvedValue(okAudio());
    const { container } = render(
      <AudioPlayer source={{ kind: 'id', fileId: 'file-1' }} fileName="show.ogg" />
    );
    fireEvent.error(await findAudio(container));

    expect(screen.getByRole('alert')).toHaveTextContent('This audio format cannot be played here.');
    expect(container.querySelector('audio')).toBeNull();
  });

  it('does not carry an unplayable file over to the next source', async () => {
    mockFetch.mockImplementation(async () => okAudio());
    const { container, rerender } = render(
      <AudioPlayer source={{ kind: 'id', fileId: 'file-1' }} fileName="first.ogg" />
    );
    fireEvent.error(await findAudio(container));
    expect(screen.getByRole('alert')).toHaveTextContent('This audio format cannot be played here.');

    rerender(<AudioPlayer source={{ kind: 'id', fileId: 'file-2' }} fileName="second.mp3" />);

    const next = await findAudio(container);
    expect(next).toHaveAttribute('src', 'blob:test-1');
    expect(next).toHaveAccessibleName('Play second.mp3');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(revoked).toEqual(['blob:test-0']);
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/files/file-2/raw'),
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('ignores an error from a previous file once the next one is playing', async () => {
    mockFetch.mockImplementation(async () => okAudio());
    const { container, rerender } = render(
      <AudioPlayer source={{ kind: 'id', fileId: 'file-1' }} fileName="first.mp3" />
    );
    const first = await findAudio(container);

    rerender(<AudioPlayer source={{ kind: 'id', fileId: 'file-2' }} fileName="second.mp3" />);
    const next = await findAudio(container);
    expect(next).not.toBe(first);

    // The first element is gone; its late error (its URL was just revoked)
    // must not mark the second file unplayable.
    fireEvent.error(first);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('audio')).toBe(next);
  });
});
