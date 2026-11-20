import React, { useState, useRef, useCallback, useEffect } from 'react';
import { getApiUrl } from '@desktop/utils/api/core';
import { getErrorMessage, sleep } from '@snaglet/shared/utils';
import { Button } from '@desktop/components';
import styles from './CopilotDeviceFlow.module.scss';

interface CopilotDeviceFlowProps {
  onToken: (token: string) => void;
  /**
   * The same device-code UI is hosted in two credential flows:
   * - Providers collects the token, then the user explicitly saves it with Connect.
   * - Onboarding auto-persists from onToken and advances without a separate button.
   */
  completionMode?: 'explicit-save' | 'auto-save';
  /**
   * Start the flow on mount instead of showing the idle Sign in button, for
   * hosts whose own Sign in with GitHub button opened this flow.
   */
  autoStart?: boolean;
}

/** What Sign in with GitHub does, shown under the idle button and as a tooltip. */
export const GITHUB_DEVICE_FLOW_HINT =
  'Opens github.com/login/device — authorize to connect your Copilot subscription.';

type FlowState =
  | { step: 'idle' }
  | { step: 'requesting' }
  | { step: 'waiting'; userCode: string; verificationUri: string }
  | { step: 'complete'; token: string }
  | { step: 'error'; message: string };

const POLL_INTERVAL_MS = 5000;

export const CopilotDeviceFlow: React.FC<CopilotDeviceFlowProps> = ({
  onToken,
  completionMode = 'explicit-save',
  autoStart = false,
}) => {
  // An auto-started flow opens on "requesting" so the idle Sign in button
  // never flashes before the mount effect starts the request.
  const [state, setState] = useState<FlowState>(
    autoStart ? { step: 'requesting' } : { step: 'idle' }
  );
  const abortRef = useRef<AbortController | null>(null);

  const startFlow = useCallback(async () => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setState({ step: 'requesting' });

    try {
      const res = await fetch(getApiUrl('/auth/copilot/device-code'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abort.signal,
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const msg =
          typeof data.message === 'string'
            ? data.message
            : typeof data.error === 'string'
              ? data.error
              : `Failed (${res.status})`;
        setState({ step: 'error', message: msg });
        return;
      }

      const data = (await res.json()) as {
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        expiresIn: number;
        interval: number;
      };

      setState({ step: 'waiting', userCode: data.userCode, verificationUri: data.verificationUri });

      // Open GitHub in browser
      window.open(data.verificationUri, '_blank');

      // Poll for completion
      const pollInterval = Math.max(POLL_INTERVAL_MS, (data.interval ?? 5) * 1000);
      const deadline = Date.now() + data.expiresIn * 1000;

      while (Date.now() < deadline && !abort.signal.aborted) {
        await sleep(pollInterval);
        if (abort.signal.aborted) return;

        const pollRes = await fetch(getApiUrl('/auth/copilot/poll'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceCode: data.deviceCode }),
          signal: abort.signal,
        });

        if (!pollRes.ok) continue;
        const pollData = (await pollRes.json()) as Record<string, unknown>;

        if (pollData.status === 'complete' && typeof pollData.accessToken === 'string') {
          setState({ step: 'complete', token: pollData.accessToken });
          onToken(pollData.accessToken);
          return;
        }
        if (pollData.status === 'expired' || pollData.status === 'denied') {
          setState({ step: 'error', message: String(pollData.error ?? 'Authorization failed') });
          return;
        }
        if (pollData.status === 'error') {
          setState({ step: 'error', message: String(pollData.error ?? 'Unknown error') });
          return;
        }
        // 'pending' or 'slow_down' — keep polling
      }

      if (!abort.signal.aborted) {
        setState({ step: 'error', message: 'Device code expired. Try again.' });
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setState({ step: 'error', message: getErrorMessage(e, 'Failed to start device flow') });
    }
  }, [onToken]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState({ step: 'idle' });
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Mount-only. Under StrictMode's remount the cleanup above aborts the first
  // request and this starts a fresh one, so exactly one poll loop survives.
  useEffect(() => {
    if (autoStart) void startFlow();
  }, []);

  if (state.step === 'idle' || state.step === 'error') {
    return (
      <div className={styles.container}>
        <Button variant="primary" size="md" onClick={startFlow}>
          Sign in with GitHub
        </Button>
        {state.step === 'error' && <span className={styles.error}>{state.message}</span>}
        <p className={styles.hint}>{GITHUB_DEVICE_FLOW_HINT}</p>
      </div>
    );
  }

  if (state.step === 'requesting') {
    return (
      <div className={styles.container}>
        <span className={styles.status}>Requesting device code...</span>
      </div>
    );
  }

  if (state.step === 'waiting') {
    return (
      <div className={styles.container}>
        <div className={styles.codeBox}>
          <span className={styles.codeLabel}>Enter this code at GitHub:</span>
          <code className={styles.userCode}>{state.userCode}</code>
          <a
            href={state.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
          >
            {state.verificationUri}
          </a>
        </div>
        <div className={styles.actions}>
          <span className={styles.status}>Waiting for authorization...</span>
          <Button variant="ghost" size="md" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // complete
  return (
    <div className={styles.container}>
      <span className={styles.success}>
        {completionMode === 'explicit-save'
          ? 'GitHub token acquired. Click Connect to save.'
          : 'GitHub token acquired. Saving automatically…'}
      </span>
    </div>
  );
};
