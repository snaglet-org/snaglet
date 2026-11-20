import { useEffect, useState } from 'react';
import type { McpConnectInfo } from '@snaglet/shared/types';
import { mcpApiKeysApi } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';

export interface UseMcpConnectInfo {
  info: McpConnectInfo | null;
  error: string | null;
}

/**
 * This Snaglet's connect info from the server (home, profile, `snaglet` command,
 * port), fetched each time a client pane opens: the port and the CLI install
 * can change between visits. It never carries the key.
 */
export function useMcpConnectInfo(): UseMcpConnectInfo {
  const [info, setInfo] = useState<McpConnectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    mcpApiKeysApi
      .connectInfo()
      .then((next) => {
        if (!live) return;
        setInfo(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (live) setError(getErrorMessage(err, 'Could not load the connection details.'));
      });
    return () => {
      live = false;
    };
  }, []);

  return { info, error };
}
