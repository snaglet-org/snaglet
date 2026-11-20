/**
 * Clarification — the wire schema for the `get_clarification` tool, shared by the
 * tool handler (server), the socket layer, and the UI form renderer.
 *
 * An agent calls `get_clarification` with one or more questions; the run blocks
 * while the user answers an interactive form rendered in the thread; the answers
 * flow back as the tool result.
 */

export type ClarificationQuestionType = 'text' | 'single_select' | 'multi_select';

export interface ClarificationQuestion {
  /** Stable, agent-chosen key the answer is read back by (e.g. "deploy_target"). */
  id: string;
  /** The question, in plain language. */
  prompt: string;
  type: ClarificationQuestionType;
  /** Choices for single_select / multi_select. Ignored for text. */
  options?: string[];
  /** Select types: also offer a free-text "Other…" answer outside the options. */
  allowOther?: boolean;
  /** multi_select: minimum number of choices the user must pick. Default 1. */
  minSelect?: number;
  /** multi_select: maximum number of choices. Omit for unlimited. */
  maxSelect?: number;
  /** Whether an answer is required to proceed. Default true. */
  required?: boolean;
}

export interface ClarificationRequest {
  /** Optional one-line preamble shown above the questions. */
  preamble?: string;
  questions: ClarificationQuestion[];
}

export type ClarificationStatus = 'answered' | 'dismissed' | 'timed_out';

/** One question's answer, keyed back to the question by id. */
export interface ClarificationAnswer {
  /** Free-text answer (type='text') or the "Other…" text on a select. */
  text?: string | null;
  /** Selected option(s): length 1 for single_select, 0..n for multi_select. */
  selected?: string[];
}

export interface ClarificationResult {
  status: ClarificationStatus;
  /** Keyed by question id. Empty unless status === 'answered'. */
  answers: Record<string, ClarificationAnswer>;
}

/** server -> client: render the clarification form in the thread. */
export interface ClarificationRequestPayload {
  /** Thread the question belongs to. Pending clarifications are keyed by thread
   *  so they survive a UI reload (new session) and re-emit on session:resume. */
  threadId: string;
  callId: string;
  agentId?: string;
  runId?: string;
  request: ClarificationRequest;
}

/** client -> server: the user's answers (or a dismissal). */
export interface ClarificationResponsePayload {
  /** Chat session answering. Omit it (and send `threadId`) from a surface with no chat open. */
  sessionId?: string;
  threadId?: string;
  callId: string;
  status: ClarificationStatus;
  answers: Record<string, ClarificationAnswer>;
}
