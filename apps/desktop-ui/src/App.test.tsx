import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { userProfileApi } from '@desktop/utils/api';
import { ACTIVE_USER_ID_KEY } from '@desktop/config';

vi.mock('@desktop/pages/Dashboard', () => ({
  Dashboard: () => <main>Dashboard ready</main>,
}));

vi.mock('@desktop/components', () => ({
  ToastHost: () => null,
  WsStatusIndicator: () => null,
}));

vi.mock('@desktop/ws/WebSocketContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/ws/WebSocketContext')>();
  const wsStub = {
    connectionState: 'open' as const,
    serverRestarting: false,
    send: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    addMessageListener: vi.fn(() => () => {}),
  };
  return {
    ...actual,
    WebSocketProvider: ({ children }: { children: React.ReactNode }) => (
      <actual.WebSocketContext.Provider value={wsStub}>{children}</actual.WebSocketContext.Provider>
    ),
  };
});

vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  FeatureFlagsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    userProfileApi: {
      listUsers: vi.fn(),
      setActive: vi.fn(),
    },
  };
});

describe('App fresh launch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.mocked(userProfileApi.listUsers).mockResolvedValue([
      {
        id: 'local_user',
        name: 'Local User',
        email: 'local-user@snaglet.local',
        picture: null,
        active: true,
      },
    ]);
    vi.mocked(userProfileApi.setActive).mockResolvedValue({
      id: 'local_user',
      name: 'Local User',
      email: 'local-user@snaglet.local',
      picture: null,
      active: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hides the browser-preview badge unless it is explicitly enabled', () => {
    vi.stubEnv('VITE_SNAGLET_BUILD_PROFILE', 'browser-preview');

    render(<App />);

    expect(screen.queryByTestId('build-profile-banner')).not.toBeInTheDocument();
  });

  it('shows the browser-preview badge when explicitly enabled', () => {
    vi.stubEnv('VITE_SNAGLET_BUILD_PROFILE', 'browser-preview');
    vi.stubEnv('VITE_SNAGLET_SHOW_BUILD_PROFILE_BANNER', 'true');

    render(<App />);

    expect(screen.getByTestId('build-profile-banner')).toHaveTextContent('Snaglet Browser Preview');
  });

  it('renders Dashboard directly without a setup gate', async () => {
    window.history.pushState({}, '', '/');

    render(<App />);

    expect(screen.getByText('Dashboard ready')).toBeInTheDocument();
    expect(screen.queryByText(/set up snaglet/i)).not.toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem(ACTIVE_USER_ID_KEY)).toBe('local_user'));
    expect(userProfileApi.setActive).not.toHaveBeenCalled();
  });

  it.each(['/database', '/database/agents'])(
    'sends the removed %s page to the Dashboard',
    (path) => {
      window.history.pushState({}, '', path);

      render(<App />);

      expect(screen.getByText('Dashboard ready')).toBeInTheDocument();
      expect(window.location.pathname).toBe('/');
    }
  );
});
