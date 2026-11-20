import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { subscribeWorkspaceTree } from '../workspaceTreeFeed';

/**
 * How many landed responses in a row the sidebar may set aside as older than
 * its own patches before it applies one anyway, so a steady stream of
 * patches (doc saves while someone types) cannot stop the tree refreshing.
 */
const MAX_SET_ASIDE_IN_A_ROW = 2;

/**
 * The workspace tree payload: loaded once, refetched when `refreshNonce`
 * (realtime events) or the returned `reloadKey` (local writes) moves. A
 * failed refetch keeps the loaded tree; only a failed first load leaves
 * `roots` null. Fetches go through the shared, coalesced tree feed
 * (`subscribeWorkspaceTree`). `loadedReloadKey` is the `reloadKey` the shown
 * tree was fetched for.
 *
 * Callers patch `roots` optimistically through `setRoots`. A response that
 * may predate such a patch is set aside and a follow-up fetch requested, so
 * a stale fetch never flashes a moved row back.
 */
export function useWorkspaceTreeRoots(refreshNonce: number) {
  const [roots, setRootsState] = useState<LibraryTreeChild[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadedReloadKey, setLoadedReloadKey] = useState(0);
  const reloadKeyRef = useRef(reloadKey);
  const patchCountRef = useRef(0);
  const requestedAtPatchRef = useRef(0);
  const requestRef = useRef<(() => void) | null>(null);

  const setRoots = useCallback<Dispatch<SetStateAction<LibraryTreeChild[] | null>>>((action) => {
    patchCountRef.current += 1;
    setRootsState(action);
  }, []);

  useEffect(() => {
    let fetchingFor = reloadKeyRef.current;
    let patchAtStart = patchCountRef.current;
    let confirmedAtStart = true;
    let setAsideInARow = 0;
    const subscription = subscribeWorkspaceTree({
      onStart: () => {
        fetchingFor = reloadKeyRef.current;
        patchAtStart = patchCountRef.current;
        confirmedAtStart = requestedAtPatchRef.current === patchAtStart;
        setError(null);
      },
      onTree: (tree) => {
        const predatesPatch = !confirmedAtStart || patchCountRef.current !== patchAtStart;
        if (predatesPatch && setAsideInARow < MAX_SET_ASIDE_IN_A_ROW) {
          setAsideInARow += 1;
          request();
          return;
        }
        setAsideInARow = 0;
        setRootsState(tree);
        setLoadedReloadKey(fetchingFor);
      },
      onError: (err) => setError(getErrorMessage(err, 'Failed to load workspace')),
    });
    const request = () => {
      requestedAtPatchRef.current = patchCountRef.current;
      subscription.request();
    };
    requestRef.current = request;
    return () => {
      subscription.close();
      requestRef.current = null;
    };
  }, []);

  // Declared after the effect above, so on mount the first request (the
  // first load) finds the subscription and starts at once.
  useEffect(() => {
    reloadKeyRef.current = reloadKey;
    requestRef.current?.();
  }, [reloadKey, refreshNonce]);

  return {
    roots,
    setRoots,
    error,
    reloadKey,
    setReloadKey,
    loadedReloadKey,
  };
}
