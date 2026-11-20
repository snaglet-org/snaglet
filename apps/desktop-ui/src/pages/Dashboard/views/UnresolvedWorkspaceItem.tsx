import { useContext, useEffect, useRef, useState, type FC } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button, Cluster, EmptyState } from '@desktop/components';
import { archiveApi, containersApi, FetchError, type LibraryTreeChild } from '@desktop/utils/api';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { WebSocketContext } from '@desktop/ws/WebSocketContext';
import { indexWorkspaceNodes } from '../selection/workspaceNodeIndex';
import { archivedDrawerReachable, requestArchivedDrawer } from './archivedDrawerRequest';

/**
 * How long a pane waits for the dashboard's own tree hydration before it
 * looks the item up itself. Restored panes normally hydrate well inside this.
 */
export const UNRESOLVED_ITEM_GRACE_MS = 1500;

/** First automatic retry after a failed lookup; doubles per failure up to the cap. */
export const UNRESOLVED_ITEM_RETRY_MS = 5_000;
const UNRESOLVED_ITEM_RETRY_MAX_MS = 60_000;

type Lookup = 'pending' | 'unreachable' | 'archived' | 'missing';

interface UnresolvedWorkspaceItemProps {
  /** Workspace node id the pane points at. */
  id: string;
  /** Hand a freshly-loaded node back to the pane so it can render. */
  onResolved?: (node: LibraryTreeChild) => void;
  onClosePane?: () => void;
}

/**
 * A workspace selection whose node is not in the pane's cache — a restored
 * pane, a chip link, or an agent navigation. The dashboard hydrates these
 * from the tree; when that does not happen (the item was archived or deleted,
 * or appeared after the tree was read) this looks the item up once and
 * either hands the node back or explains why the pane is empty, instead of
 * loading forever. A failed lookup says so and retries on its own: after a
 * growing delay, on the next workspace tree refresh, when the socket
 * reconnects, or from its Try again button.
 */
export const UnresolvedWorkspaceItem: FC<UnresolvedWorkspaceItemProps> = ({
  id,
  onResolved,
  onClosePane,
}) => {
  const [lookup, setLookup] = useState<Lookup>('pending');
  const [attempt, setAttempt] = useState(0);
  const [failures, setFailures] = useState(0);
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;

  const connectionState = useContext(WebSocketContext)?.connectionState ?? null;
  const previousConnectionRef = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionRef.current;
    previousConnectionRef.current = connectionState;
    if (connectionState === 'open' && previous !== null && previous !== 'open') {
      setAttempt((value) => value + 1);
    }
  }, [connectionState]);

  useEffect(() => {
    let canceled = false;
    const resolve = async () => {
      try {
        const { node } = await archiveApi.counts(id);
        if (canceled) return;
        if (node.archived) {
          setLookup('archived');
          return;
        }
        const found = indexWorkspaceNodes(await containersApi.listTree()).get(id);
        if (canceled) return;
        if (found && onResolvedRef.current) {
          onResolvedRef.current(found);
          return;
        }
        setLookup('missing');
      } catch (err) {
        if (canceled) return;
        if (err instanceof FetchError && err.status === 404) {
          setLookup('missing');
          return;
        }
        console.error('UnresolvedWorkspaceItem: lookup failed', getErrorMessage(err));
        setLookup('unreachable');
        setFailures((value) => value + 1);
      }
    };
    const timer = window.setTimeout(
      () => void resolve(),
      attempt === 0 ? UNRESOLVED_ITEM_GRACE_MS : 0
    );
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [id, attempt]);

  // Keep trying while Snaglet is unreachable: after a growing delay, and on the
  // next workspace tree refresh (a reconnect or remote change emits one).
  useEffect(() => {
    if (lookup !== 'unreachable') return;
    const retry = () => setAttempt((value) => value + 1);
    const delay = Math.min(
      UNRESOLVED_ITEM_RETRY_MAX_MS,
      UNRESOLVED_ITEM_RETRY_MS * 2 ** Math.max(0, failures - 1)
    );
    const timer = window.setTimeout(retry, delay);
    const stop = onLibraryEvent((event) => {
      if (event.type === 'tree-invalidated') retry();
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [lookup, failures]);

  if (lookup === 'pending') {
    return <EmptyState title="Loading workspace item" body="Fetching the latest workspace data…" />;
  }
  if (lookup === 'unreachable') {
    return (
      <EmptyState
        title="Can't load this item right now"
        body="Snaglet can't be reached right now. This pane keeps trying on its own."
        action={
          <Cluster gap={2}>
            <Button variant="neutral" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </Button>
            {onClosePane && (
              <Button variant="ghost" size="sm" onClick={onClosePane}>
                Close pane
              </Button>
            )}
          </Cluster>
        }
      />
    );
  }
  const offerArchive = lookup === 'archived' && archivedDrawerReachable();
  return (
    <EmptyState
      title="This item isn't available"
      body={
        lookup === 'archived'
          ? 'It was archived. You can restore it from the Archived drawer.'
          : 'It may have been archived or deleted.'
      }
      action={
        onClosePane || offerArchive ? (
          <Cluster gap={2}>
            {offerArchive && (
              <Button variant="neutral" size="sm" onClick={requestArchivedDrawer}>
                Open Archived
              </Button>
            )}
            {onClosePane && (
              <Button variant="ghost" size="sm" onClick={onClosePane}>
                Close pane
              </Button>
            )}
          </Cluster>
        ) : undefined
      }
    />
  );
};
