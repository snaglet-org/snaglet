/**
 * A `file:` reference to an absolute path, as an agent writes it in a message
 * or doc, renders as a file chip; clicking it opens the path preview modal,
 * which plays an audio file from the by-path raw route. The path need not be
 * indexed: the by-path routes only require it to sit inside a live project's
 * linked folder (pinned server-side in files.raw.test.ts).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';

const mocks = vi.hoisted(() => ({ getContentByPath: vi.fn() }));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    filesApi: { ...actual.filesApi, getContentByPath: mocks.getContentByPath },
  };
});
vi.mock('./useWorkspaceAncestors', () => ({ useWorkspaceAncestors: () => [] }));

const EPISODE = '/projects/example/episodes/2026-01-01/show.mp3';
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.getContentByPath.mockResolvedValue({
    id: EPISODE,
    relativePath: 'show.mp3',
    sizeBytes: 5_000_000,
    content: null,
    previewable: false,
    reason: 'too_large',
  });
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    blob: async () => new Blob(['audio-bytes'], { type: 'audio/mpeg' }),
  });
  global.fetch = mockFetch;
  URL.createObjectURL = vi.fn(() => 'blob:test-episode');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  // Unmount while the URL stubs exist: the player revokes its URL on unmount.
  cleanup();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

it('opens the audio player from a file reference in a message', async () => {
  const { container } = render(
    <MarkdownRenderer
      content={`Today's episode: [show.mp3](file:${EPISODE})`}
      showIncludeToggle={false}
    />
  );

  const chip = container.querySelector('a.md-chip.md-chip-file');
  expect(chip).not.toBeNull();
  expect(chip?.getAttribute('data-node-id')).toBe(EPISODE);
  expect(chip?.querySelector('.md-chip-title')?.textContent).toBe('show.mp3');

  fireEvent.click(chip as Element);

  expect(mocks.getContentByPath).toHaveBeenCalledWith(EPISODE);
  await waitFor(() => {
    expect(screen.getByLabelText('Play show.mp3')).toHaveAttribute('src', 'blob:test-episode');
  });
  const [rawUrl] = mockFetch.mock.calls[0] as [string];
  expect(rawUrl).toContain(`/api/files/raw?${new URLSearchParams({ path: EPISODE }).toString()}`);
});
