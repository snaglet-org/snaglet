import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_MODEL_REMOVAL_UI_FLAG } from '@snaglet/shared/types';

const featureFlagsGet = vi.hoisted(() => vi.fn());
vi.mock('@desktop/utils/api', () => ({
  featureFlagsApi: { get: featureFlagsGet },
}));

import {
  FeatureFlagsProvider,
  useFeatureFlag,
  useFeatureFlagGuard,
  useRefreshFeatureFlags,
} from './FeatureFlagsContext';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const FlagProbe = () => (
  <output>{useFeatureFlag(LOCAL_MODEL_REMOVAL_UI_FLAG) ? 'enabled' : 'disabled'}</output>
);

beforeEach(() => {
  featureFlagsGet.mockReset();
});

describe('FeatureFlagsProvider', () => {
  it('fails closed during loading, then exposes an explicit true value without flashing', async () => {
    const pending = deferred<{ local_model_removal_ui: boolean }>();
    featureFlagsGet.mockReturnValue(pending.promise);

    render(
      <FeatureFlagsProvider>
        <FlagProbe />
      </FeatureFlagsProvider>
    );

    expect(screen.getByText('disabled')).toBeTruthy();
    await act(() => {
      pending.resolve({ local_model_removal_ui: true });
      return pending.promise;
    });
    expect(screen.getByText('enabled')).toBeTruthy();
  });

  it('keeps error and absent values disabled', async () => {
    featureFlagsGet.mockRejectedValueOnce(new Error('offline'));
    const first = render(
      <FeatureFlagsProvider>
        <FlagProbe />
      </FeatureFlagsProvider>
    );
    await waitFor(() => expect(featureFlagsGet).toHaveBeenCalledTimes(1));
    expect(screen.getByText('disabled')).toBeTruthy();

    first.unmount();
    featureFlagsGet.mockResolvedValueOnce({} as { local_model_removal_ui: boolean });
    render(
      <FeatureFlagsProvider>
        <FlagProbe />
      </FeatureFlagsProvider>
    );
    await waitFor(() => expect(featureFlagsGet).toHaveBeenCalledTimes(2));
    expect(screen.getByText('disabled')).toBeTruthy();
  });

  it('does not let an older request overwrite a newer refresh', async () => {
    const stale = deferred<{ local_model_removal_ui: boolean }>();
    const current = deferred<{ local_model_removal_ui: boolean }>();
    featureFlagsGet.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);

    const RefreshProbe = () => {
      const enabled = useFeatureFlag(LOCAL_MODEL_REMOVAL_UI_FLAG);
      const refresh = useRefreshFeatureFlags();
      return (
        <div>
          <output>{enabled ? 'enabled' : 'disabled'}</output>
          <button onClick={() => void refresh()}>Refresh flags</button>
        </div>
      );
    };

    render(
      <FeatureFlagsProvider>
        <RefreshProbe />
      </FeatureFlagsProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh flags' }));

    await act(() => {
      current.resolve({ local_model_removal_ui: true });
      return current.promise;
    });
    expect(screen.getByText('enabled')).toBeTruthy();

    await act(() => {
      stale.resolve({ local_model_removal_ui: false });
      return stale.promise;
    });
    expect(screen.getByText('enabled')).toBeTruthy();
  });

  it('refreshes shared truth and makes retained destructive guards read the latest value', async () => {
    featureFlagsGet
      .mockResolvedValueOnce({ local_model_removal_ui: true })
      .mockResolvedValueOnce({ local_model_removal_ui: false });
    const retainedGuard = { current: () => false, captured: false };

    const GuardProbe = () => {
      const { enabled, isEnabled } = useFeatureFlagGuard(LOCAL_MODEL_REMOVAL_UI_FLAG);
      const refresh = useRefreshFeatureFlags();
      const firstGuard = useRef(isEnabled);
      if (!retainedGuard.captured) {
        retainedGuard.current = firstGuard.current;
        retainedGuard.captured = true;
      }
      return (
        <div>
          <output>{enabled ? 'enabled' : 'disabled'}</output>
          <button onClick={() => void refresh()}>Refresh flags</button>
        </div>
      );
    };

    render(
      <FeatureFlagsProvider>
        <GuardProbe />
      </FeatureFlagsProvider>
    );
    await waitFor(() => expect(screen.getByText('enabled')).toBeTruthy());
    expect(retainedGuard.current()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh flags' }));
    await waitFor(() => expect(screen.getByText('disabled')).toBeTruthy());
    expect(retainedGuard.current()).toBe(false);
    expect(featureFlagsGet).toHaveBeenCalledTimes(2);
  });
});
