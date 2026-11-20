import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { splitDocRef } from '@snaglet/shared/utils';
import { docsApi, type TransclusionLoopStep } from '@desktop/utils/api';
import { showToast } from '@desktop/utils/toast';
import { useHostDocId } from '../lineLinks/hostDoc';

/**
 * Transclusions in the editor: `![title](doc-id)` shows another doc's content
 * in place. A doc may not transclude itself or any doc that transcludes it.
 * The server refuses such a save; these helpers let the editor refuse the
 * gesture first and keep a loop already in stored data from expanding.
 */

/** The one-line explanation wherever a person can turn a link into a transclusion. */
export const TRANSCLUDE_TIP = "Transclude a doc: show another doc's content here, kept in sync.";

/** Doc ids from the doc being read down to the transclusion being rendered. */
const ChainContext = createContext<readonly string[] | null>(null);

export function TransclusionChainProvider({
  ids,
  children,
}: {
  ids: readonly string[];
  children: ReactNode;
}) {
  return <ChainContext.Provider value={ids}>{children}</ChainContext.Provider>;
}

/** The docs already shown above this point; the host doc when at the top. */
export function useTransclusionChain(): readonly string[] {
  const chain = useContext(ChainContext);
  const hostDocId = useHostDocId();
  return chain ?? (hostDocId ? [hostDocId] : []);
}

/** What the person sees when a transclusion would loop. */
function transclusionLoopNotice(loop: readonly TransclusionLoopStep[]): string {
  const target = loop[1]?.title ?? 'that doc';
  const chain = loop.map((step) => step.title).join(' → ');
  return `Can't transclude "${target}" here: it would make a loop (${chain}). Nothing was changed.`;
}

/** The loop a refused save names, when a loop is why it was refused. */
function transclusionLoopOf(err: unknown): TransclusionLoopStep[] | null {
  const details = (err as { details?: { transclusionLoop?: unknown } } | null)?.details;
  const loop = details?.transclusionLoop;
  return Array.isArray(loop) ? (loop as TransclusionLoopStep[]) : null;
}

/**
 * The notice for saves the server refuses because they would loop: shown
 * once per loop, not again for each autosave that keeps the same loop, and
 * shown afresh after a save goes through.
 */
export function useSaveLoopNotice(): { refused: (err: unknown) => void; saved: () => void } {
  const shown = useRef<string | null>(null);
  return useMemo(
    () => ({
      refused: (err: unknown) => {
        const loop = transclusionLoopOf(err);
        if (!loop) return;
        const key = loop.map((step) => step.id).join(' ');
        if (shown.current === key) return;
        shown.current = key;
        showToast(transclusionLoopNotice(loop), { durationMs: 6000 });
      },
      saved: () => {
        shown.current = null;
      },
    }),
    []
  );
}

/**
 * Check before turning a link into a transclusion in the doc being edited.
 * Resolves false, after showing the notice, when it would loop. Outside a
 * doc body, or when the check itself fails, it allows the change: the save
 * is checked again on the server.
 */
export function useTransclusionGuard(): (href: string) => Promise<boolean> {
  const hostDocId = useHostDocId();
  return useCallback(
    async (href: string) => {
      const target = splitDocRef(href).id;
      if (!hostDocId || !target.startsWith('doc-')) return true;
      let loop: TransclusionLoopStep[] | null = null;
      try {
        loop = (await docsApi.transclusionLoop(hostDocId, target)).loop;
      } catch {
        return true;
      }
      if (!loop) return true;
      showToast(transclusionLoopNotice(loop), { durationMs: 6000 });
      return false;
    },
    [hostDocId]
  );
}
