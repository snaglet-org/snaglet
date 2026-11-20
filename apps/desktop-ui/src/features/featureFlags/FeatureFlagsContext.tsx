import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import type { FrontendFeatureFlagName, FrontendFeatureFlags } from '@snaglet/shared/types';

import { featureFlagsApi } from '@desktop/utils/api';

type FeatureFlagsStatus = 'loading' | 'ready' | 'error';

interface FeatureFlagsContextValue {
  flags: FrontendFeatureFlags | null;
  status: FeatureFlagsStatus;
  refresh: () => Promise<void>;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | null>(null);

export const FeatureFlagsProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [flags, setFlags] = useState<FrontendFeatureFlags | null>(null);
  const [status, setStatus] = useState<FeatureFlagsStatus>('loading');
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestSequence.current;
    setStatus('loading');
    setFlags(null);
    try {
      const next = await featureFlagsApi.get();
      if (request !== requestSequence.current) return;
      setFlags(next);
      setStatus('ready');
    } catch {
      if (request !== requestSequence.current) return;
      setFlags(null);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [refresh]);

  const value = useMemo(() => ({ flags, status, refresh }), [flags, refresh, status]);
  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>;
};

/** Unknown, loading, missing-provider, and error states all resolve false. */
export function useFeatureFlag(name: FrontendFeatureFlagName): boolean {
  const context = useContext(FeatureFlagsContext);
  return context?.status === 'ready' && context.flags?.[name] === true;
}

/**
 * True once the flags have loaded or failed to load, so a one-time decision
 * (what the window opens with) can tell "off" from "not known yet". Always
 * false without a provider.
 */
export function useFeatureFlagsSettled(): boolean {
  const context = useContext(FeatureFlagsContext);
  return context?.status === 'ready' || context?.status === 'error';
}

export function useRefreshFeatureFlags(): () => Promise<void> {
  const context = useContext(FeatureFlagsContext);
  return context?.refresh ?? (async () => undefined);
}

/**
 * Stable guard for destructive handlers. A callback retained from an older
 * render reads the latest committed flag value instead of its stale closure.
 */
export function useFeatureFlagGuard(name: FrontendFeatureFlagName): {
  enabled: boolean;
  isEnabled: () => boolean;
} {
  const enabled = useFeatureFlag(name);
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  const isEnabled = useCallback(() => enabledRef.current, []);
  return useMemo(() => ({ enabled, isEnabled }), [enabled, isEnabled]);
}
