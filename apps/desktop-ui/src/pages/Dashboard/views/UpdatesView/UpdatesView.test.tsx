import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/components', async () => {
  const controls = await vi.importActual<typeof import('@desktop/components/controls')>(
    '@desktop/components/controls'
  );
  return { Button: controls.Button };
});
vi.mock('@desktop/utils/api', () => ({
  appUpdateApi: { status: vi.fn(), checkNow: vi.fn() },
}));
const updateState = vi.hoisted(() => ({
  current: {
    offer: null as string | null,
    running: false,
    message: null as string | null,
    failure: null as string | null,
  },
}));
vi.mock('@desktop/utils/appUpdate', () => ({
  offerAppUpdate: vi.fn(),
  appUpdateUnsupportedReason: vi.fn(async () => null),
  useAppUpdateState: () => updateState.current,
}));

import { appUpdateApi } from '@desktop/utils/api';
import { appUpdateUnsupportedReason, offerAppUpdate } from '@desktop/utils/appUpdate';
import { UpdatesView } from './UpdatesView';

const RELEASE_URL = 'https://github.com/owner/repo/releases/tag/v1.0.1';
const upToDate = {
  currentVersion: '1.0.0',
  lastCheckedAt: '2026-11-20T10:00:00.000Z',
  latest: { version: 'v1.0.0', url: 'https://example.com/v1.0.0', publishedAt: null, name: null },
  updateAvailable: false,
  lastError: null,
};
const available = {
  ...upToDate,
  latest: { version: 'v1.0.1', url: RELEASE_URL, publishedAt: null, name: null },
  updateAvailable: true,
};

beforeEach(() => {
  vi.mocked(appUpdateApi.status).mockResolvedValue(upToDate);
  vi.mocked(appUpdateUnsupportedReason).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  updateState.current = { offer: null, running: false, message: null, failure: null };
});

describe('UpdatesView', () => {
  it('shows the installed version and that it is up to date', async () => {
    render(<UpdatesView />);
    expect(await screen.findByRole('heading', { name: 'Snaglet 1.0.0' })).toBeInTheDocument();
    expect(screen.getByText('You’re up to date')).toBeInTheDocument();
    expect(screen.getByText(/^Last checked /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install and restart' })).not.toBeInTheDocument();
  });

  it('says when no check has run yet', async () => {
    vi.mocked(appUpdateApi.status).mockResolvedValue({
      ...upToDate,
      lastCheckedAt: null,
      latest: null,
    });
    render(<UpdatesView />);
    expect(await screen.findByText('Not checked yet')).toBeInTheDocument();
    expect(screen.queryByText(/^Last checked /)).not.toBeInTheDocument();
  });

  it('offers the available release through the shared prompt and install flow', async () => {
    vi.mocked(appUpdateApi.status).mockResolvedValue(available);
    const user = userEvent.setup();
    render(<UpdatesView />);
    expect(await screen.findByText('Snaglet v1.0.1 is available')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Release notes for Snaglet v1.0.1' })).toHaveAttribute(
      'href',
      RELEASE_URL
    );
    await user.click(await screen.findByRole('button', { name: 'Install and restart' }));
    expect(offerAppUpdate).toHaveBeenCalledTimes(1);
    expect(offerAppUpdate).toHaveBeenCalledWith('v1.0.1');
  });

  it('shows the running update’s progress and does not offer it twice', async () => {
    vi.mocked(appUpdateApi.status).mockResolvedValue(available);
    updateState.current = {
      offer: null,
      running: true,
      message: 'Downloading Snaglet 1.0.1… 42%',
      failure: null,
    };
    render(<UpdatesView />);
    expect(await screen.findByText('Downloading Snaglet 1.0.1… 42%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Installing…' })).toBeDisabled();
  });

  it('says why a build cannot update itself and links the release page instead', async () => {
    vi.mocked(appUpdateApi.status).mockResolvedValue(available);
    vi.mocked(appUpdateUnsupportedReason).mockResolvedValue(
      'Snaglet Preview doesn’t install updates.'
    );
    render(<UpdatesView />);
    expect(await screen.findByText('Snaglet Preview doesn’t install updates.')).toBeInTheDocument();
    expect(screen.getByText('Snaglet v1.0.1 is available')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Release notes for Snaglet v1.0.1' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install and restart' })).not.toBeInTheDocument();
  });

  it('says why the last check failed and keeps the known release as last known', async () => {
    vi.mocked(appUpdateApi.status).mockResolvedValue({
      ...available,
      lastError: 'Snaglet couldn’t reach GitHub.',
    });
    render(<UpdatesView />);
    expect(
      await screen.findByText('Couldn’t check: Snaglet couldn’t reach GitHub.')
    ).toBeInTheDocument();
    expect(screen.getByText('Last known release: Snaglet v1.0.1')).toBeInTheDocument();
    expect(screen.queryByText('Snaglet v1.0.1 is available')).not.toBeInTheDocument();
    expect(screen.getByText('Check failed')).toBeInTheDocument();
    expect(screen.queryByText('Current')).not.toBeInTheDocument();
    expect(screen.getByText(/^Last successful check /)).toBeInTheDocument();
  });

  it('shows a neutral state when the status cannot be loaded', async () => {
    vi.mocked(appUpdateApi.status)
      .mockRejectedValueOnce(new Error('Server unavailable'))
      .mockResolvedValueOnce(upToDate);
    const user = userEvent.setup();
    render(<UpdatesView />);
    expect(await screen.findByRole('heading', { name: 'Couldn’t load' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Server unavailable');
    expect(screen.queryByText('Current')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Snaglet/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Snaglet 1.0.0' })).toBeInTheDocument();
  });

  it('keeps the last install failure visible until the next attempt', async () => {
    vi.mocked(appUpdateApi.status).mockResolvedValue(available);
    updateState.current = {
      offer: null,
      running: false,
      message: 'The downloaded update failed its signature check.',
      failure: 'The downloaded update failed its signature check.',
    };
    render(<UpdatesView />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Last install attempt failed: The downloaded update failed its signature check.'
    );
  });

  it('checks now and shows the new result', async () => {
    vi.mocked(appUpdateApi.checkNow).mockResolvedValue(available);
    const user = userEvent.setup();
    render(<UpdatesView />);
    await user.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(appUpdateApi.checkNow).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Snaglet v1.0.1 is available')).toBeInTheDocument();
  });

  it('shows a failed check request as an error', async () => {
    vi.mocked(appUpdateApi.checkNow).mockRejectedValue(new Error('Server unavailable'));
    const user = userEvent.setup();
    render(<UpdatesView />);
    await user.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable');
  });
});
