import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileView } from './ProfileView';
import { userProfileApi } from '@desktop/utils/api';
import { ACTIVE_USER_CHANGED_EVENT, ACTIVE_USER_ID_KEY } from '@desktop/config';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    userProfileApi: {
      get: vi.fn(),
      update: vi.fn(),
      listUsers: vi.fn(),
      createUser: vi.fn(),
      setActive: vi.fn(),
    },
  };
});

const profile = {
  id: 'local_user',
  name: 'Local User',
  email: 'local-user@snaglet.local',
  picture: null,
  active: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const testUser = {
  ...profile,
  id: 'test_user',
  name: 'Test User',
  email: 'user@example.com',
};

function mockApi() {
  vi.mocked(userProfileApi.get).mockResolvedValue(profile);
  vi.mocked(userProfileApi.listUsers).mockResolvedValue([profile]);
  vi.mocked(userProfileApi.createUser).mockResolvedValue({ ...testUser, active: false });
  vi.mocked(userProfileApi.setActive).mockResolvedValue({ ...testUser, active: true });
  vi.mocked(userProfileApi.update).mockResolvedValue(profile);
}

describe('ProfileView header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockApi();
  });

  // The person gets no avatar: the header card holds the title and nothing else.
  it('renders the title alone, with no avatar tile beside it', async () => {
    render(<ProfileView />);
    const title = await screen.findByRole('heading', { level: 1, name: 'My profile' });
    const header = title.closest('header');
    expect(header).not.toBeNull();
    expect(header?.children).toHaveLength(1);
    expect(header?.firstElementChild).toBe(title);
    expect(header).not.toHaveTextContent('☻');
  });
});

describe('ProfileView user creation and switching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockApi();
  });

  it('creates an inactive user, refreshes the list, and keeps the current active user', async () => {
    const user = userEvent.setup();
    vi.mocked(userProfileApi.listUsers)
      .mockResolvedValueOnce([profile])
      .mockResolvedValueOnce([profile, { ...testUser, active: false }]);

    render(<ProfileView />);
    await screen.findByDisplayValue('Local User');

    await user.click(screen.getByRole('button', { name: 'Create user' }));
    expect(screen.getByRole('dialog', { name: 'Create user' })).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: 'Create user' });
    expect(within(dialog).getByLabelText('Name')).toHaveFocus();
    await user.type(within(dialog).getByLabelText('Name'), 'Test User');
    await user.type(within(dialog).getByLabelText('Email (optional)'), 'user@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create user' })).toBeNull());
    expect(userProfileApi.createUser).toHaveBeenCalledWith({
      name: 'Test User',
      email: 'user@example.com',
      makeActive: false,
    });
    expect(window.localStorage.getItem(ACTIVE_USER_ID_KEY)).toBe('local_user');
    expect(screen.getByRole('combobox', { name: 'Acting as' })).toHaveValue('local_user');
  });

  it('creates an active user, updates local identity, and refetches profile immediately', async () => {
    const user = userEvent.setup();
    const listener = vi.fn();
    window.addEventListener(ACTIVE_USER_CHANGED_EVENT, listener);
    vi.mocked(userProfileApi.createUser).mockResolvedValue({ ...testUser, active: true });
    vi.mocked(userProfileApi.get)
      .mockResolvedValueOnce(profile)
      .mockResolvedValueOnce({ ...testUser, active: true });
    vi.mocked(userProfileApi.listUsers)
      .mockResolvedValueOnce([profile])
      .mockResolvedValueOnce([profile, { ...testUser, active: true }]);

    render(<ProfileView />);
    await screen.findByDisplayValue('Local User');

    await user.click(screen.getByRole('button', { name: 'Create user' }));
    const dialog = screen.getByRole('dialog', { name: 'Create user' });
    await user.type(within(dialog).getByLabelText('Name'), 'Test User');
    await user.click(within(dialog).getByLabelText('Make active on this device'));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));

    await waitFor(() => expect(window.localStorage.getItem(ACTIVE_USER_ID_KEY)).toBe('test_user'));
    await screen.findByDisplayValue('Test User');
    expect(userProfileApi.createUser).toHaveBeenCalledWith({
      name: 'Test User',
      email: undefined,
      makeActive: true,
    });
    expect(listener).toHaveBeenCalled();
    window.removeEventListener(ACTIVE_USER_CHANGED_EVENT, listener);
  });

  it('surfaces create failures and allows retry without double submit', async () => {
    const user = userEvent.setup();
    vi.mocked(userProfileApi.createUser)
      .mockRejectedValueOnce(new Error('Duplicate user'))
      .mockResolvedValueOnce({ ...testUser, active: false });
    vi.mocked(userProfileApi.listUsers)
      .mockResolvedValueOnce([profile])
      .mockResolvedValueOnce([profile, { ...testUser, active: false }]);

    render(<ProfileView />);
    await screen.findByDisplayValue('Local User');
    await user.click(screen.getByRole('button', { name: 'Create user' }));
    const dialog = screen.getByRole('dialog', { name: 'Create user' });
    await user.type(within(dialog).getByLabelText('Name'), 'Test User');
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Duplicate user');
    expect(userProfileApi.createUser).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create user' })).toBeNull());
    expect(userProfileApi.createUser).toHaveBeenCalledTimes(2);
  });

  it('prevents duplicate create submits while a request is in flight', async () => {
    const user = userEvent.setup();
    vi.mocked(userProfileApi.createUser).mockImplementation(() => new Promise(() => undefined));

    render(<ProfileView />);
    await screen.findByDisplayValue('Local User');
    await user.click(screen.getByRole('button', { name: 'Create user' }));
    const dialog = screen.getByRole('dialog', { name: 'Create user' });
    await user.type(within(dialog).getByLabelText('Name'), 'Test User');
    const button = within(dialog).getByRole('button', { name: 'Create user' });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(userProfileApi.createUser).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: 'Creating…' })).toBeDisabled();
  });

  it('reports a failed user-list refresh after a create instead of dropping it', async () => {
    const user = userEvent.setup();
    vi.mocked(userProfileApi.listUsers)
      .mockResolvedValueOnce([profile])
      .mockRejectedValueOnce(new Error('users unavailable'));

    render(<ProfileView />);
    await screen.findByDisplayValue('Local User');
    await user.click(screen.getByRole('button', { name: 'Create user' }));
    const dialog = screen.getByRole('dialog', { name: 'Create user' });
    await user.type(within(dialog).getByLabelText('Name'), 'Test User');
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('users unavailable');
    expect(screen.queryByRole('dialog', { name: 'Create user' })).toBeNull();
  });

  it('does not call a saved profile a failed save when the list refresh fails', async () => {
    const user = userEvent.setup();
    vi.mocked(userProfileApi.update).mockResolvedValue({ ...profile, name: 'Test User' });
    vi.mocked(userProfileApi.listUsers)
      .mockResolvedValueOnce([profile])
      .mockRejectedValueOnce(new Error('users unavailable'));

    render(<ProfileView />);
    const nameInput = await screen.findByDisplayValue('Local User');
    await user.clear(nameInput);
    await user.type(nameInput, 'Test User');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('users unavailable');
    expect(alert).not.toHaveTextContent('Save failed');
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('switches users through the server before updating local identity', async () => {
    const user = userEvent.setup();
    vi.mocked(userProfileApi.listUsers).mockResolvedValue([
      profile,
      { ...testUser, active: false },
    ]);

    render(<ProfileView />);
    const select = await screen.findByRole('combobox', { name: 'Acting as' });

    await user.selectOptions(select, 'test_user');

    await waitFor(() => expect(userProfileApi.setActive).toHaveBeenCalledWith('test_user'));
    expect(window.localStorage.getItem(ACTIVE_USER_ID_KEY)).toBe('test_user');
    expect(screen.getByDisplayValue('Test User')).toBeInTheDocument();
  });
});
