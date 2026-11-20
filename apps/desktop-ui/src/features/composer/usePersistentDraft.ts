/**
 * usePersistentDraft — a composer's text kept in localStorage under a
 * caller-chosen key, so a draft survives unmounts, pane switches and
 * reloads. Writes are debounced (300 ms) and flushed on unmount or key
 * change; only text the user changed is written, so merely mounting a
 * composer never rewrites what is stored.
 *
 * Keys are full storage keys. `draftStorageKey('thread-system-prompt:<id>')`
 * builds one in the shared namespace; the chat composer uses its own prefix.
 */
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { safeJsonParse } from '@snaglet/shared/utils';

interface StoredDraft {
  text?: unknown;
}

const DRAFT_PREFIX = 'snaglet:draft:';
const DEBOUNCE_MS = 300;

/** Storage key for a draft scope such as `thread-system-prompt:<id>`. */
export function draftStorageKey(scope: string): string {
  return DRAFT_PREFIX + scope;
}

/** The stored text for `key`, or null when nothing is stored. */
export function readStoredDraft(key: string | undefined): string | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const stored = safeJsonParse<StoredDraft | null>(raw, null);
    return typeof stored?.text === 'string' ? stored.text : null;
  } catch {
    return null;
  }
}

/**
 * Store `text` under `key`. Blank text, or text equal to `baseline` (what
 * the field starts from, e.g. an entry's current body), removes the entry
 * instead: there is nothing worth restoring.
 */
function writeStoredDraft(key: string | undefined, text: string, baseline = ''): void {
  if (!key) return;
  try {
    if (!text.trim() || text === baseline) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify({ text }));
  } catch {
    // Storage full or unavailable: the draft stays in memory only.
  }
}

function clearStoredDraft(key: string | undefined): void {
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing was stored either.
  }
}

export interface PersistentDraft {
  draftText: string;
  /** A user edit: marks the draft for saving. */
  setDraftText: (next: SetStateAction<string>) => void;
  /** Forget the stored draft and empty the field (after a successful send). */
  clearDraft: () => void;
  /** Forget the stored draft but leave the field as is (the host is closing it). */
  discardDraft: () => void;
}

/**
 * @param key storage key; undefined keeps the draft in memory only.
 * @param initialText what the field starts from when nothing is stored.
 */
export function usePersistentDraft(key: string | undefined, initialText = ''): PersistentDraft {
  const [draftText, setText] = useState(() => readStoredDraft(key) ?? initialText);
  const latestText = useRef(draftText);
  latestText.current = draftText;
  const baseline = useRef(initialText);
  baseline.current = initialText;
  const dirty = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingWrite = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  // A new key is a different draft. The previous key's draft was flushed by
  // the cleanup below before this runs.
  const prevKey = useRef(key);
  useEffect(() => {
    if (prevKey.current === key) return;
    prevKey.current = key;
    dirty.current = false;
    setText(readStoredDraft(key) ?? baseline.current);
  }, [key]);

  useEffect(() => {
    if (!dirty.current) return;
    cancelPendingWrite();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      writeStoredDraft(key, latestText.current, baseline.current);
    }, DEBOUNCE_MS);
    return cancelPendingWrite;
  }, [draftText, key]);

  // Flush on unmount / key change so the last keystroke is never lost.
  useEffect(
    () => () => {
      cancelPendingWrite();
      if (dirty.current) writeStoredDraft(key, latestText.current, baseline.current);
    },
    [key]
  );

  const setDraftText = useCallback((next: SetStateAction<string>) => {
    dirty.current = true;
    setText(next);
  }, []);

  const discardDraft = useCallback(() => {
    cancelPendingWrite();
    dirty.current = false;
    clearStoredDraft(key);
  }, [key]);

  const clearDraft = useCallback(() => {
    discardDraft();
    setText('');
  }, [discardDraft]);

  return { draftText, setDraftText, clearDraft, discardDraft };
}
