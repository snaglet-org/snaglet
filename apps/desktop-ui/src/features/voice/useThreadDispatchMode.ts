// Fetches a thread's dispatch/routing mode. All current routing modes support
// voice; the provider retains this value so a future unknown mode can fail
// closed. Fetched once per thread; a live update would need a thread-config WS
// event (documented gap).

import { useEffect, useState } from 'react';
import { threadsApi } from '@desktop/utils/api';

export type DispatchMode = 'all' | 'mentioned' | 'unsupported';

export function useThreadDispatchMode(threadId: string): DispatchMode | null {
  const [mode, setMode] = useState<DispatchMode | null>(null);
  useEffect(() => {
    let canceled = false;
    setMode(null);
    threadsApi
      .getDispatchModeState(threadId)
      .then((dispatchMode) => {
        if (!canceled) setMode(dispatchMode);
      })
      .catch(() => {
        if (!canceled) setMode(null);
      });
    return () => {
      canceled = true;
    };
  }, [threadId]);
  return mode;
}
