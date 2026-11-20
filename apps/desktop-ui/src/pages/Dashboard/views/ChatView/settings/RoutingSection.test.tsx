import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/utils/api', () => ({
  threadsApi: {
    get: vi.fn().mockResolvedValue({ id: 'thread-1', dispatchMode: 'mentioned' }),
    updateDispatchMode: vi.fn(),
  },
}));
import { threadsApi } from '@desktop/utils/api';
import { RoutingSection } from './RoutingSection';

describe('RoutingSection', () => {
  it('chooses who replies; the conversation limits are not here (they are under General)', async () => {
    render(<RoutingSection threadId="thread-1" />);
    expect(await screen.findByRole('radio', { name: /@mention only/ })).toBeChecked();
    expect(
      screen.getByText(/Limits on how far one message runs are in the General tab/)
    ).toBeInTheDocument();
    expect(screen.queryByText('Max dispatch waves')).not.toBeInTheDocument();
    expect(screen.queryByText('Conversation budget')).not.toBeInTheDocument();
  });

  it('says a one-agent thread replies without a mention in @mention only mode', async () => {
    render(<RoutingSection threadId="thread-1" />);
    await screen.findByRole('radio', { name: /@mention only/ });
    expect(
      screen.getByText(/With one agent in the thread, it replies to every message\./)
    ).toBeInTheDocument();
  });

  it('replaces the loading hint with the error when the thread cannot load', async () => {
    vi.mocked(threadsApi.get).mockRejectedValueOnce(new Error('thread unavailable'));
    render(<RoutingSection threadId="thread-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('thread unavailable');
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.queryByText('Up to date')).toBeNull();
  });
});
