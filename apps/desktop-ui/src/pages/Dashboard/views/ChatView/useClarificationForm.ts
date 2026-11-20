import { useEffect, useMemo, useState } from 'react';
import type {
  ClarificationAnswer,
  ClarificationQuestion,
  ClarificationRequestPayload,
  ClarificationStatus,
} from '@snaglet/shared/types';
import { safeJsonParse } from '@snaglet/shared/utils';

/** Sentinel option value for the "Other:" free-text choice. */
export const OTHER = '__other__';

export interface QState {
  selected: string[];
  otherText: string;
}

export type FormState = Record<string, QState>;

interface Draft {
  step: number;
  state: FormState;
}

// In-progress answers survive a remount (pane added/rearranged) and a page
// refresh: the request itself is re-emitted by the server on reconnect
// (clarifications are parked by thread), so only the local draft was lost.
// The composer panel and the cursor-side card share this one draft per callId.
const draftKey = (callId: string): string => `snaglet:clarification-draft:${callId}`;

function loadDraft(callId: string, questions: ClarificationQuestion[]): Draft | null {
  try {
    const raw = sessionStorage.getItem(draftKey(callId));
    if (!raw) return null;
    const parsed = safeJsonParse<Draft | null>(raw, null);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.step !== 'number') return null;
    // Only trust drafts that cover this exact question set.
    if (!questions.every((q) => parsed.state?.[q.id])) return null;
    return { step: Math.min(parsed.step, questions.length - 1), state: parsed.state };
  } catch {
    return null;
  }
}

function clearDraft(callId: string): void {
  try {
    sessionStorage.removeItem(draftKey(callId));
  } catch {
    // storage unavailable — nothing to clear
  }
}

export type ClarificationRespond = (
  callId: string,
  status: ClarificationStatus,
  answers: Record<string, ClarificationAnswer>
) => void;

const required = (q: ClarificationQuestion): boolean => q.required !== false;

const isAnsweredIn = (q: ClarificationQuestion, s: QState): boolean => {
  if (q.type === 'text') return s.otherText.trim().length > 0;
  const picks = s.selected.filter((v) => v !== OTHER).length;
  const other = s.selected.includes(OTHER) && s.otherText.trim().length > 0 ? 1 : 0;
  const count = picks + other;
  return q.type === 'multi_select' ? count >= (q.minSelect ?? 1) : count >= 1;
};

/**
 * The answer state + submit logic of an Ask request, shared by the composer
 * panel (ClarificationPrompt) and the cursor-side card so both behave alike.
 */
export function useClarificationForm(
  request: ClarificationRequestPayload,
  onRespond: ClarificationRespond
) {
  const { callId, request: req } = request;
  const questions = req.questions;

  const draft = useMemo(() => loadDraft(callId, questions), [callId, questions]);
  const [step, setStep] = useState(draft?.step ?? 0);
  const [state, setState] = useState<FormState>(
    () =>
      draft?.state ??
      Object.fromEntries(questions.map((q) => [q.id, { selected: [], otherText: '' }]))
  );

  // Persist the draft on every change so a remount/refresh restores it.
  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey(callId), JSON.stringify({ step, state }));
    } catch {
      // storage unavailable — degrade to pre-draft behavior
    }
  }, [callId, step, state]);

  const respond = (
    status: ClarificationStatus,
    answers: Record<string, ClarificationAnswer>
  ): void => {
    clearDraft(callId);
    onRespond(callId, status, answers);
  };

  const update = (id: string, patch: Partial<QState>): void =>
    setState((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  /** The next selection for `value` on `q`, or null when maxSelect blocks adding it. */
  const nextSelected = (q: ClarificationQuestion, value: string, from: QState): string[] | null => {
    if (q.type === 'single_select') return [value];
    const has = from.selected.includes(value);
    if (!has && q.maxSelect && from.selected.length >= q.maxSelect) return null;
    return has ? from.selected.filter((v) => v !== value) : [...from.selected, value];
  };

  const select = (q: ClarificationQuestion, value: string): void => {
    const next = nextSelected(q, value, state[q.id]);
    if (next) update(q.id, { selected: next });
  };

  const isAnswered = (q: ClarificationQuestion): boolean => isAnsweredIn(q, state[q.id]);

  const allAnswered = useMemo(
    () => questions.every((q) => !required(q) || isAnsweredIn(q, state[q.id])),
    [questions, state]
  );

  const buildAnswers = (from: FormState = state): Record<string, ClarificationAnswer> => {
    const out: Record<string, ClarificationAnswer> = {};
    for (const q of questions) {
      const s = from[q.id];
      if (q.type === 'text') {
        out[q.id] = { text: s.otherText.trim() || null };
      } else {
        const selected = s.selected.filter((v) => v !== OTHER);
        const includesOther = s.selected.includes(OTHER);
        out[q.id] = { selected, text: includesOther ? s.otherText.trim() || null : null };
      }
    }
    return out;
  };

  const q = questions[step];
  const isLast = step === questions.length - 1;

  return {
    questions,
    preamble: req.preamble,
    step,
    setStep,
    state,
    q,
    s: state[q.id],
    isLast,
    canAdvance: !required(q) || isAnswered(q),
    allAnswered,
    required,
    update,
    select,
    nextSelected,
    isAnswered,
    buildAnswers,
    respond,
  };
}
