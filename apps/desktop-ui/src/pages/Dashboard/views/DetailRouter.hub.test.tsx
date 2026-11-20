/**
 * DetailRouter and the `hub_home` flag: off (the default) nothing changes, a
 * restored Home pane is just an empty pane; on, Home renders and the profile
 * pane opens Home, except through Home's own Account link.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const flags = vi.hoisted(() => ({ hub: false }));
vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlag: (name: string) => (name === 'hub_home' ? flags.hub : false),
}));
vi.mock('./HubView', async () => {
  const { createElement } = await import('react');
  return { HubView: () => createElement('div', null, 'Home pane') };
});
vi.mock('./ProfileView', async () => {
  const { createElement } = await import('react');
  return { ProfileView: () => createElement('div', null, 'Profile pane') };
});

import { DetailRouter } from './DetailRouter';

beforeEach(() => {
  flags.hub = false;
});

describe('DetailRouter with hub_home off (the default)', () => {
  it('opens the profile pane as before', () => {
    render(<DetailRouter selection={{ kind: 'profile' }} />);
    expect(screen.getByText('Profile pane')).toBeInTheDocument();
    expect(screen.queryByText('Home pane')).toBeNull();
  });

  it('shows a restored Home pane as an empty pane', () => {
    render(<DetailRouter selection={{ kind: 'hub' }} />);
    expect(screen.getByText('Nothing open here')).toBeInTheDocument();
    expect(screen.queryByText('Home pane')).toBeNull();
  });
});

describe('DetailRouter with hub_home on', () => {
  beforeEach(() => {
    flags.hub = true;
  });

  it('renders Home', () => {
    render(<DetailRouter selection={{ kind: 'hub' }} />);
    expect(screen.getByText('Home pane')).toBeInTheDocument();
  });

  it('opens Home in place of the profile pane', () => {
    render(<DetailRouter selection={{ kind: 'profile' }} />);
    expect(screen.getByText('Home pane')).toBeInTheDocument();
    expect(screen.queryByText('Profile pane')).toBeNull();
  });

  it('still reaches the profile pane through Home’s Account link', () => {
    render(<DetailRouter selection={{ kind: 'profile', account: true }} />);
    expect(screen.getByText('Profile pane')).toBeInTheDocument();
  });
});
