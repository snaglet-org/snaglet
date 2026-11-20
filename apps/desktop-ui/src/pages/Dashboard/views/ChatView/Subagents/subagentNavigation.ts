import { createContext, useContext } from 'react';

/**
 * What a thread's result lines need to open a helper's thread: which helpers
 * still exist, and the pane navigation. ChatView provides it, so the
 * memoized message rows need no extra props.
 */
export interface SubagentNavigation {
  /** Hidden threads of the thread's live helpers. */
  liveThreadIds: ReadonlySet<string>;
  /** Open a helper's thread in this pane; null where the view cannot navigate (previews). */
  openHelperThread: ((threadId: string, title: string) => void) | null;
}

export const SubagentNavigationContext = createContext<SubagentNavigation | null>(null);

export function useSubagentNavigation(): SubagentNavigation | null {
  return useContext(SubagentNavigationContext);
}
