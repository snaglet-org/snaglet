import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { sleep } from '@snaglet/shared/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopilotDeviceFlow, GITHUB_DEVICE_FLOW_HINT } from './CopilotDeviceFlow';

vi.mock('@desktop/config.js', () => ({
  clientConfig: { apiBaseUrl: '/api', appName: 'Snaglet' },
  desktopSessionToken: null,
  ACTIVE_USER_ID_KEY: 'snaglet.activeUserId',
  getActiveUserId: () => null,
}));

vi.mock('@snaglet/shared/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@snaglet/shared/utils')>()),
  sleep: vi.fn(() => Promise.resolve()),
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('open', vi.fn());
});

afterEach(() => {
  vi.mocked(sleep).mockReset();
  vi.mocked(sleep).mockImplementation(() => Promise.resolve());
  vi.unstubAllGlobals();
});

function mockCompletedDeviceFlow() {
  fetchMock
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          deviceCode: 'device-code',
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          expiresIn: 60,
          interval: 5,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'complete', accessToken: 'gho_secret_token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
}

describe('CopilotDeviceFlow host contract', () => {
  it('uses truthful auto-save completion copy for onboarding hosts', async () => {
    const user = userEvent.setup();
    const onToken = vi.fn();
    mockCompletedDeviceFlow();

    render(<CopilotDeviceFlow completionMode="auto-save" onToken={onToken} />);

    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));

    expect(
      await screen.findByText('GitHub token acquired. Saving automatically…')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Click Connect/i)).not.toBeInTheDocument();
    expect(onToken).toHaveBeenCalledWith('gho_secret_token');
  });

  it('uses explicit Connect completion copy for providers hosts', async () => {
    const user = userEvent.setup();
    mockCompletedDeviceFlow();

    render(<CopilotDeviceFlow completionMode="explicit-save" onToken={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));

    expect(
      await screen.findByText('GitHub token acquired. Click Connect to save.')
    ).toBeInTheDocument();
  });

  it('starts on mount with autoStart, without showing the idle Sign in button', async () => {
    const onToken = vi.fn();
    mockCompletedDeviceFlow();

    render(<CopilotDeviceFlow autoStart completionMode="explicit-save" onToken={onToken} />);

    expect(screen.getByText('Requesting device code...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub' })).not.toBeInTheDocument();
    expect(
      await screen.findByText('GitHub token acquired. Click Connect to save.')
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/copilot/device-code');
    expect(window.open).toHaveBeenCalledWith('https://github.com/login/device', '_blank');
    expect(onToken).toHaveBeenCalledWith('gho_secret_token');
  });

  it('falls back to the idle Sign in button and hint after an auto-started flow is canceled', async () => {
    const user = userEvent.setup();
    vi.mocked(sleep).mockImplementationOnce(() => new Promise(() => {}));
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          deviceCode: 'device-code',
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          expiresIn: 60,
          interval: 5,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    render(<CopilotDeviceFlow autoStart onToken={vi.fn()} />);

    expect(await screen.findByText('ABCD-1234')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
    expect(screen.getByText(GITHUB_DEVICE_FLOW_HINT)).toBeInTheDocument();
  });

  it('waits for a click without autoStart', () => {
    render(<CopilotDeviceFlow onToken={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts in-flight polling when the flow unmounts', async () => {
    const user = userEvent.setup();
    const observedSignals: AbortSignal[] = [];

    vi.mocked(sleep).mockImplementationOnce(() => new Promise(() => {}));

    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.signal instanceof AbortSignal) {
        observedSignals.push(init.signal);
      }
      return new Response(
        JSON.stringify({
          deviceCode: 'device-code',
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          expiresIn: 60,
          interval: 5,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const { unmount } = render(<CopilotDeviceFlow onToken={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    await screen.findByText('Waiting for authorization...');
    unmount();

    expect(observedSignals.length).toBeGreaterThan(0);
    expect(observedSignals[0].aborted).toBe(true);
  });
});
