/**
 * A loop already in stored content never expands on screen: a transclusion of
 * a doc already shown above it renders a short notice and is not fetched.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, docsApi: { ...actual.docsApi, get: api.get } };
});

import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { HostDocProvider } from '../lineLinks/hostDoc';
import { TransclusionBlock } from './TransclusionBlock';

const A = 'doc-1111111111111-aaaaaaaaa';
const B = 'doc-2222222222222-bbbbbbbbb';

const docs: Record<string, { id: string; title: string; content: string }> = {
  [A]: { id: A, title: 'Plan', content: `plan body\n\n![](${B})` },
  [B]: { id: B, title: 'Terms', content: `terms body\n\n![](${A})` },
};

describe('a transclusion loop in stored content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation(async (id: string) => docs[id]);
  });

  it('shows a notice instead of the doc the reader is already in', () => {
    render(
      <HostDocProvider docId={A}>
        <TransclusionBlock href={A} title="Plan" />
      </HostDocProvider>
    );
    expect(screen.getByRole('note')).toHaveTextContent(
      'Not shown: this doc is already shown above, so showing it here would loop.'
    );
    expect(api.get).not.toHaveBeenCalled();
  });

  it('expands the other doc once, then stops at the repeat', async () => {
    render(
      <HostDocProvider docId={A}>
        <TransclusionBlock href={B} title="Terms" />
      </HostDocProvider>
    );
    expect(await screen.findByText('terms body')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('note')).toBeInTheDocument());
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(B);
    expect(screen.queryByText('plan body')).not.toBeInTheDocument();
  });
});

describe('a transclusion stays in sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation(async (id: string) => docs[id]);
  });

  it('shows a save of the transcluded doc without a reload', async () => {
    render(<TransclusionBlock href={B} title="Terms" />);
    expect(await screen.findByText(/terms body/)).toBeInTheDocument();
    act(() => {
      emitLibraryEvent({ type: 'doc-saved', id: B, content: 'terms edited by an agent' });
    });
    expect(await screen.findByText('terms edited by an agent')).toBeInTheDocument();
    act(() => {
      emitLibraryEvent({ type: 'doc-saved', id: A, content: 'some other doc' });
    });
    expect(screen.queryByText('some other doc')).not.toBeInTheDocument();
  });
});
