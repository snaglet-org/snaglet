/**
 * Thread history trimming — shared request/response contract.
 *
 * Trimming permanently removes a contiguous run of a thread's history from one
 * or both ends, together with every dependent execution record (runs, agent
 * activity, embeddings). Summaries are the exception: they are the compressed
 * memory of what is being deleted, so they go only when the user asks for them
 * to (see {@link ThreadTrimSummaryImpact}).
 *
 * There is exactly one operation: pick the first and the last retained message.
 * That two-handle range already expresses every cut — leave the first handle at
 * the oldest message and only newer history goes; leave the last handle at the
 * newest and only older history goes; move both and both sides go. The contract
 * therefore carries no "mode": the sides being cut are *derived* from where the
 * boundaries sit relative to the thread's ends, so the client cannot declare an
 * intent that disagrees with the interval it submitted.
 *
 * The contract is deliberately two-phase:
 *
 *   1. `preview` — the client proposes a retained interval; the server resolves
 *      it to exact message ids, expands it for run atomicity, computes the
 *      canonical counts/bytes, and mints a signed plan token.
 *   2. `apply` — the client returns the exact reviewed plan plus its token. The
 *      server re-derives everything from live rows inside one transaction and
 *      refuses the delete if the thread moved underneath the preview.
 *
 * The client never supplies counts or byte totals that the server trusts.
 */

/**
 * Which side(s) of the transcript a resolved plan really removes.
 *
 * Derived server-side from the retained interval, never sent by a client. It
 * exists so the confirmation copy, the audit log line and the broadcast can all
 * describe the same cut in words without each re-deriving it.
 */
export type ThreadTrimSides = 'none' | 'prefix' | 'tail' | 'both';

/**
 * On-disk bytes attributable to a set of thread rows, split by owning table.
 *
 * Every figure is `pg_column_size()` summed server-side over the exact rows in
 * question, so it reflects real stored width (including TOAST-compressed text
 * and generated tsvector columns) rather than a UTF-16 string length guess.
 */
export interface ThreadTrimBytes {
  /** `public.messages` rows. */
  messages: number;
  /** `public.embeddings` rows whose `node_id` is one of those messages. */
  messageEmbeddings: number;
  /** `public.runs` rows. */
  runs: number;
  /** `public.agent_activity_log` rows hanging off those runs. */
  activity: number;
  /** `public.thread_summaries` rows. */
  summaries: number;
  /** `public.embeddings` rows whose `node_id` is one of those summaries. */
  summaryEmbeddings: number;
  /** Sum of every field above. */
  total: number;
}

/** Row counts + byte weight for a set of thread records. */
export interface ThreadTrimTotals {
  messages: number;
  summaries: number;
  runs: number;
  activity: number;
  bytes: ThreadTrimBytes;
}

/** One end of the retained interval, resolved to an exact message. */
export interface ThreadTrimBoundary {
  messageId: string;
  /** 0-based ordinal in `(created_at, id)` order across the whole thread. */
  index: number;
  createdAt: string;
  role: 'user' | 'assistant';
  agentId: string | null;
  userId: string | null;
  /** Best available display name for the author; null when unattributable. */
  authorLabel: string | null;
}

/**
 * What happens to the thread's summaries under this plan.
 *
 * A summary is the compressed memory OF the history it covers, so trimming
 * never destroys one on its own initiative: `removeSummaries` is the only thing
 * that deletes a summary. A summary whose covered span intersects deleted
 * history is instead kept and its coverage bookkeeping repaired —
 * `messages_covered` drops to 0 and `last_message_id` is cleared — so the row
 * stops accounting for messages that no longer exist and the next summarization
 * pass re-reads the whole retained transcript on top of the text it already
 * holds.
 *
 * The trade this makes, stated rather than hidden: a repaired summary still
 * contains prose condensed from deleted messages, and it stays `is_current`, so
 * it still reaches prompt assembly and search. Trimming reclaims context; it is
 * not an expunge. `removeSummaries` is the expunge.
 */
export interface ThreadTrimSummaryImpact {
  /** Deleted because the user checked "remove summaries". */
  removedByChoice: number;
  /**
   * Deleted summaries that also covered removed history — a subset of the
   * deleted set, reported apart from `removedByChoice` so the two reasons
   * partition it without double counting. Zero unless `removeSummaries` is
   * true, because stale coverage on its own no longer deletes anything.
   */
  removedAsInvalidated: number;
  /** Total summaries kept (`total - removed`), repaired ones included. */
  preserved: number;
  /**
   * Kept summaries whose `messages_covered` / `last_message_id` were reset
   * because their coverage reached into deleted history. A subset of
   * `preserved`; zero when `removeSummaries` is true.
   */
  repairedCoverage: number;
  /** Total summaries deleted (`removedByChoice + removedAsInvalidated`). */
  removed: number;
  /** Bytes freed by the removed summaries, including their embeddings. */
  removedBytes: number;
}

/** Canonical thread-wide totals for the top bar. */
export interface ThreadTrimStats {
  threadId: string;
  /** Number of messages, i.e. the slider's domain is `[0, messageCount - 1]`. */
  messageCount: number;
  totals: ThreadTrimTotals;
  /** True when a run is in flight; trimming is blocked until it settles. */
  threadBusy: boolean;
}

/**
 * Preview request body. Indices and ids are interchangeable; ids win.
 *
 * Omitting an edge means "do not cut this side": the first defaults to the
 * oldest message and the last to the newest.
 */
export interface ThreadTrimPreviewRequest {
  firstRetainedIndex?: number;
  firstRetainedMessageId?: string;
  lastRetainedIndex?: number;
  lastRetainedMessageId?: string;
  removeSummaries: boolean;
}

export interface ThreadTrimPreview {
  threadId: string;
  /** Which sides this plan really cuts, derived from the resolved interval. */
  sides: ThreadTrimSides;
  removeSummaries: boolean;
  /** Exactly what the client asked for, echoed back as resolved ordinals. */
  requested: { firstRetainedIndex: number; lastRetainedIndex: number };
  /** The interval that will actually be retained, after run-atomicity expansion. */
  firstRetained: ThreadTrimBoundary;
  lastRetained: ThreadTrimBoundary;
  /**
   * True when the retained interval had to grow so that no run ends up with
   * some of its messages deleted and some kept. The UI must surface this: the
   * user's handle position is not the cut that will happen.
   */
  expandedForRunAtomicity: boolean;
  /** Whole-thread figures — identical to `ThreadTrimStats.totals`. */
  totals: ThreadTrimTotals;
  /** What this plan deletes. */
  removed: ThreadTrimTotals;
  /** `totals - removed`, computed server-side so the two always agree. */
  remaining: ThreadTrimTotals;
  summaryImpact: ThreadTrimSummaryImpact;
  /** True when nothing at all would be deleted. */
  noop: boolean;
  /** True when a run is in flight; `apply` will refuse. */
  threadBusy: boolean;
  /** Opaque signed plan token; `apply` requires it verbatim. */
  token: string;
  /** Token lifetime in milliseconds, for client-side re-preview scheduling. */
  tokenTtlMs: number;
}

/** Apply request body — the exact reviewed plan plus its token. */
export interface ThreadTrimApplyRequest {
  firstRetainedMessageId: string;
  lastRetainedMessageId: string;
  removeSummaries: boolean;
  token: string;
}

export interface ThreadTrimApplyResult {
  threadId: string;
  /** Which sides were really cut, recomputed inside the deleting transaction. */
  sides: ThreadTrimSides;
  removeSummaries: boolean;
  firstRetainedMessageId: string;
  lastRetainedMessageId: string;
  /** Recomputed inside the deleting transaction — the authoritative figures. */
  removed: ThreadTrimTotals;
  remaining: ThreadTrimTotals;
  summaryImpact: ThreadTrimSummaryImpact;
  /** Id of the surviving message nearest the cut, for scroll restoration. */
  anchorMessageId: string;
}

/** Payload of the `socket:thread:trimmed` broadcast. */
export interface ThreadTrimmedBroadcast {
  threadId: string;
  sides: ThreadTrimSides;
  removedMessages: number;
  removedSummaries: number;
  removedRuns: number;
  removedActivity: number;
  firstRetainedMessageId: string;
  lastRetainedMessageId: string;
  anchorMessageId: string;
}

/** An all-zero totals block. */
export function emptyThreadTrimTotals(): ThreadTrimTotals {
  return {
    messages: 0,
    summaries: 0,
    runs: 0,
    activity: 0,
    bytes: {
      messages: 0,
      messageEmbeddings: 0,
      runs: 0,
      activity: 0,
      summaries: 0,
      summaryEmbeddings: 0,
      total: 0,
    },
  };
}
