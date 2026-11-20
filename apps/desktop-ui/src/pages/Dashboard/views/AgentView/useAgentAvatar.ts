import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultCursorSpec,
  generateColors,
  generateShape,
  type CursorSpec,
} from '@snaglet/shared/cursor';

interface UseAgentAvatarArgs {
  agentId: string;
  /** The saved spec, or null when the agent still has its id-derived default. */
  spec: CursorSpec | null;
  onSave: (patch: { cursorSpec: CursorSpec | null }) => Promise<void>;
}

/** Fresh integer seed. Only called from click handlers, never during render. */
const newSeed = () => Math.floor(Math.random() * 0x7fffffff);

/**
 * The agent's avatar (its cursor): a generated flower with a face. One action,
 * `shuffle`, picks a new shape and new colors together and saves immediately.
 * A failed save rolls the avatar back to the last saved one.
 */
export function useAgentAvatar({ agentId, spec, onSave }: UseAgentAvatarArgs) {
  const [pending, setPending] = useState<CursorSpec | null>(null);
  const [error, setError] = useState(false);
  const requestRef = useRef(0);

  // The saved prop caught up (or the agent changed): drop the optimistic copy.
  useEffect(() => setPending(null), [spec, agentId]);
  useEffect(() => setError(false), [agentId]);

  const effective = pending ?? spec ?? defaultCursorSpec(agentId);

  const shuffle = useCallback(async () => {
    const request = ++requestRef.current;
    const next: CursorSpec = {
      v: 1,
      shape: generateShape(newSeed()),
      colors: generateColors(newSeed()),
    };
    setPending(next);
    setError(false);
    try {
      await onSave({ cursorSpec: next });
    } catch {
      if (request !== requestRef.current) return;
      setPending(null);
      setError(true);
    }
  }, [onSave]);

  return { spec: effective, shuffle, error };
}
