import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoicePicker } from './VoicePicker';

const play = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../audio/playOneShot', () => ({ playOneShot: play }));
vi.mock('@desktop/utils/api/core', () => ({ getApiUrl: (value: string) => value }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('voice preview recovery', () => {
  it('shows server guidance on missing models and permits successful retry after installation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false }) // capabilities: keep fallback catalog
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: 'voice model unavailable: en_US-amy-medium' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(8),
      });
    vi.stubGlobal('fetch', fetchMock);
    render(<VoicePicker value="en_US-amy-medium" onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings → Storage');
    expect(play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
