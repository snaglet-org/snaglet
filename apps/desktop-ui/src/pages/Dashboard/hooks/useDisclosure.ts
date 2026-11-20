import { useCallback, useState } from 'react';

// useDisclosure: open/closed state for a properties panel. It always mounts
// closed and is deliberately not persisted, so reopening a pane (or switching
// to another node and back) starts collapsed again.

export function useDisclosure(): [boolean, () => void] {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((prev) => !prev), []);
  return [expanded, toggle];
}
