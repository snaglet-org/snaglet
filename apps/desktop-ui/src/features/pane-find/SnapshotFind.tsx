import { useEffect, useState, type RefObject } from 'react';
import { FindBar } from './FindBar';
import { findTextRanges, paintFindRanges } from './highlightConversation';
import { usePaneFindSession } from './PaneFindContext';

interface SnapshotFindProps {
  /** The element whose rendered, read-only text is searched. */
  rootRef: RefObject<HTMLElement | null>;
  /** The previewed content; a change re-scans the rendered text. */
  value: string;
  /** Resets the query when a different version is previewed. */
  identity: string;
}

/**
 * Find for a read-only preview (a doc's saved version). It highlights matches
 * in the rendered text and never offers Replace, so the preview stays read-only.
 */
export function SnapshotFind({ rootRef, value, identity }: SnapshotFindProps) {
  const session = usePaneFindSession(true, identity);
  const [count, setCount] = useState(0);
  const { open, query, caseSensitive, index } = session;
  useEffect(() => {
    const root = rootRef.current;
    if (!open || !query || !root) {
      setCount(0);
      return;
    }
    const ranges = findTextRanges(root, query, caseSensitive);
    setCount(ranges.length);
    return paintFindRanges(ranges, index);
  }, [rootRef, open, query, caseSensitive, index, value]);
  return <FindBar session={session} count={count} label="Find in version" />;
}
