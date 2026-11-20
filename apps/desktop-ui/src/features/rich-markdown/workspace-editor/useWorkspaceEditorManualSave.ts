/**
 * The explicit-Save engine behind `<WorkspaceEditor saveMode="manual">`.
 * Nothing is sent while typing; Save, Cmd/Ctrl+S or the submit key sends the
 * draft. A save never rewrites the draft: the sent text is remembered as
 * accepted so it reads clean even if the server canonicalizes it. A
 * `savedValue` update never overwrites a dirty draft, and unsaved drafts
 * persist in localStorage under `draftKey`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { usePersistentDraft } from '@desktop/features/composer';
import { getErrorMessage } from '@snaglet/shared/utils';

import type { WorkspaceEditorAutosaveState, WorkspaceEditorSaveResult } from './types';

interface UseWorkspaceEditorManualSaveOptions {
  savedValue: string;
  onSave: (next: string) => Promise<WorkspaceEditorSaveResult> | WorkspaceEditorSaveResult;
  /** localStorage key for the unsaved draft; undefined keeps it in memory. */
  draftKey?: string;
  savedFadeMs?: number;
}

export interface UseWorkspaceEditorManualSaveResult {
  value: string;
  /** 'dirty' whenever the draft differs from what is saved. */
  state: WorkspaceEditorAutosaveState;
  error: string | null;
  dirty: boolean;
  onChange: (next: string) => void;
  /** Send the draft now. Resolves to the saved (canonical) value. */
  flush: () => Promise<string>;
  /** Throw the draft away and show the saved value again. */
  discard: () => void;
}

/** The draft a save sent, and the canonical value the server kept for it. */
interface Accepted {
  sent: string;
  canonical: string;
}

function isClean(draft: string, baseline: string, accepted: Accepted | null): boolean {
  if (draft === baseline) return true;
  return accepted !== null && accepted.canonical === baseline && accepted.sent === draft;
}

export function useWorkspaceEditorManualSave({
  savedValue,
  onSave,
  draftKey,
  savedFadeMs = 1600,
}: UseWorkspaceEditorManualSaveOptions): UseWorkspaceEditorManualSaveResult {
  const [baseline, setBaseline] = useState(savedValue);
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const { draftText, setDraftText, discardDraft } = usePersistentDraft(draftKey, baseline);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Refs so async callbacks read the latest without re-binding.
  const draftRef = useRef(draftText);
  draftRef.current = draftText;
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const acceptedRef = useRef(accepted);
  acceptedRef.current = accepted;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const inFlightRef = useRef<Promise<string> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // External savedValue: adopt only under a clean draft. Our own echo equals
  // the baseline already and changes nothing.
  useEffect(() => {
    if (savedValue === baselineRef.current) return;
    const clean = isClean(draftRef.current, baselineRef.current, acceptedRef.current);
    baselineRef.current = savedValue;
    setBaseline(savedValue);
    if (clean) {
      acceptedRef.current = null;
      setAccepted(null);
      draftRef.current = savedValue;
      setDraftText(savedValue);
    }
  }, [savedValue, setDraftText]);

  const dirty = !isClean(draftText, baseline, accepted);

  const onChange = useCallback(
    (next: string) => {
      if (next === draftRef.current) return;
      draftRef.current = next;
      setDraftText(next);
      setPhase((prev) => (prev === 'saved' || prev === 'error' ? 'idle' : prev));
    },
    [setDraftText]
  );

  const flush = useCallback((): Promise<string> => {
    if (inFlightRef.current) return inFlightRef.current;
    const sent = draftRef.current;
    if (isClean(sent, baselineRef.current, acceptedRef.current)) {
      return Promise.resolve(baselineRef.current);
    }
    setPhase('saving');
    setError(null);
    const run = (async () => {
      try {
        const result = await onSaveRef.current(sent);
        const canonical = typeof result === 'string' ? result : sent;
        if (!mountedRef.current) return canonical;
        baselineRef.current = canonical;
        setBaseline(canonical);
        const nextAccepted = { sent, canonical };
        acceptedRef.current = nextAccepted;
        setAccepted(nextAccepted);
        // The stored draft is saved. Edits typed during the request stay and
        // are re-stored by the next keystroke.
        if (draftRef.current === sent) discardDraft();
        setPhase('saved');
        return canonical;
      } catch (err) {
        if (mountedRef.current) {
          setError(getErrorMessage(err, 'Save failed'));
          setPhase('error');
        }
        throw err;
      } finally {
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = run;
    return run;
  }, [discardDraft]);

  const discard = useCallback(() => {
    if (inFlightRef.current) return;
    discardDraft();
    acceptedRef.current = null;
    setAccepted(null);
    draftRef.current = baselineRef.current;
    setDraftText(baselineRef.current);
    // setDraftText re-marks the stored draft; a draft equal to the baseline
    // is deleted from storage, not written.
    setPhase('idle');
    setError(null);
  }, [discardDraft, setDraftText]);

  useEffect(() => {
    if (phase !== 'saved') return;
    const t = setTimeout(() => setPhase('idle'), savedFadeMs);
    return () => clearTimeout(t);
  }, [phase, savedFadeMs]);

  const state: WorkspaceEditorAutosaveState =
    phase === 'saving'
      ? 'saving'
      : phase === 'error'
        ? 'error'
        : dirty
          ? 'dirty'
          : phase === 'saved'
            ? 'saved'
            : 'pristine';

  return { value: draftText, state, error, dirty, onChange, flush, discard };
}
