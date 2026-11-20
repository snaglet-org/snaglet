import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Shared "copy chip reference" hook used by every chip surface (read-only
 * `Chip`, editable `ChipNodeView`, expanded `TransclusionBlock`). Calls
 * `navigator.clipboard.writeText(value)`, flips `copied=true` for
 * `resetMs` so callers can swap the icon to a checkmark, then resets.
 */
export function useChipCopy(resetMs = 1500): {
  copied: boolean;
  copy: (value: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const copy = useCallback(
    async (value: string) => {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => setCopied(false), resetMs);
      } catch {
        // Clipboard write can fail when the document isn't focused or
        // permission is denied; swallow silently rather than throw — the
        // user gets no visual feedback, which is the right signal.
      }
    },
    [resetMs]
  );

  return { copied, copy };
}
