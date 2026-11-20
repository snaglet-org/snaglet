/**
 * The shared user profile: every surface reads the same profile, a name saved
 * in one shows in the others at once, and a read sent before a save never
 * puts the old name back.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));

vi.mock('@desktop/utils/api', () => ({
  userProfileApi: { get: api.get, update: api.update },
}));

import { checkUserName, useUserProfile } from './userProfile';

function profile(name: string) {
  return { id: 'local_user', name };
}

/** One surface showing the name, with a way to rename. */
function Surface({ id, rename }: { id: string; rename?: string }) {
  const { profile: current, saveName } = useUserProfile();
  return (
    <div data-testid={id}>
      {current?.name ?? 'loading'}
      {rename && (
        <button type="button" onClick={() => void saveName(rename)}>
          {`rename ${id}`}
        </button>
      )}
    </div>
  );
}

beforeEach(() => {
  api.get.mockReset().mockResolvedValue(profile('Local User'));
  api.update.mockReset().mockImplementation(async ({ name }: { name: string }) => profile(name));
});

describe('useUserProfile', () => {
  it('shows a name saved in one surface in every other at once', async () => {
    render(
      <>
        <Surface id="pane" rename="Robin" />
        <Surface id="home" />
      </>
    );
    await waitFor(() => expect(screen.getByTestId('home').textContent).toBe('Local User'));

    await act(async () => {
      screen.getByRole('button', { name: 'rename pane' }).click();
    });
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update).toHaveBeenCalledWith({ name: 'Robin' });
    expect(screen.getByTestId('home').textContent).toBe('Robin');
    expect(screen.getByTestId('pane').textContent).toContain('Robin');
  });

  it('keeps a saved name when a read sent before the save lands after it', async () => {
    let answer: (value: ReturnType<typeof profile>) => void = () => undefined;
    api.get.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    render(<Surface id="pane" rename="Robin" />);
    await act(async () => {
      screen.getByRole('button', { name: 'rename pane' }).click();
    });
    await act(async () => {
      answer(profile('Local User'));
    });
    expect(screen.getByTestId('pane').textContent).toContain('Robin');
  });
});

describe('checkUserName', () => {
  it('trims the name it saves', () => {
    expect(checkUserName('  Robin ')).toEqual({ name: 'Robin', error: null });
  });

  it('refuses an empty name or one over the limit', () => {
    expect(checkUserName('   ')).toEqual({ name: null, error: 'Your name can’t be empty.' });
    expect(checkUserName('x'.repeat(81)).error).toBe('Your name can be at most 80 characters.');
  });
});
