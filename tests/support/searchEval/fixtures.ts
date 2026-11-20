/** Fixed authored judgments. IDs are resolved only after seeding; no ranking-derived labels. */
export const documents = [
  [
    'retry',
    'Retry policy',
    'Failed requests use exponential backoff with jitter, capped at sixty seconds. Repeated failures open a circuit breaker.',
  ],
  [
    'permissions',
    'Workspace access boundaries',
    'Agents may read only permitted containers. Restricted documents are excluded before retrieval, not filtered after rendering.',
  ],
  [
    'indexing',
    'File indexing lifecycle',
    'A project can pause file indexing. Paused projects keep existing indexed content but stop new scans and embedding jobs.',
  ],
  [
    'tokens',
    'Context budget accounting',
    'Tool output consumes the conversation context window. Token estimates include result headers and snippets.',
  ],
  [
    'calendar',
    'Calendar recurrence',
    'Recurring tasks can be skipped or completed without deleting the recurring schedule.',
  ],
  [
    'deployment',
    'Deployment checklist',
    'Release builds require a clean verification run and human approval. Never deploy automatically.',
  ],
  [
    'retry-old',
    'Retired retry experiment',
    'An abandoned retry experiment used a fixed five-second delay without jitter. This is historical, not the current policy.',
  ],
  [
    'index-ui',
    'Project index dashboard',
    'The indexing dashboard shows progress counts and a pause button. This document describes visual layout only.',
  ],
] as const;
export const files = [
  [
    'src/retryPolicy.ts',
    'export function calculateBackoff(attempt: number) { return Math.min(60000, 1000 * 2 ** attempt); } // retry delay with exponential growth',
  ],
  [
    'src/permissions.ts',
    'export function canReadContainer(allowed: string[], id: string) { return allowed.includes(id); } // enforce workspace access boundaries',
  ],
  [
    'src/fileIndexer.ts',
    'export function shouldIndexProject(enabled: boolean) { return enabled; } // paused projects stop filesystem scans',
  ],
  [
    'src/tokenBudget.ts',
    'export function estimateContextBudget(tokens: number) { return 32000 - tokens; } // remaining context window',
  ],
  [
    'src/calendar.ts',
    'export function skipOccurrence(id: string) { return { id, skipped: true }; } // recurring task schedule',
  ],
  [
    'tests/retryPolicy.test.ts',
    '// historical retry fixture; validates legacy fixed delay rather than current exponential policy',
  ],
  [
    'docs/retry-notes.md',
    '# Retry notes\nFor current behavior inspect src/retryPolicy.ts, not this old design discussion.',
  ],
] as const;
export const decisions = [
  [
    'retry-decision',
    'Retry cap decision',
    'We decided to cap exponential request backoff at sixty seconds and add jitter. The fixed delay proposal was rejected.',
  ],
  [
    'index-decision',
    'Paused indexing decision',
    'We agreed paused file indexing preserves existing results but stops new indexing work. Clearing old embeddings is a separate action.',
  ],
  [
    'release-decision',
    'Release approval decision',
    'The team decided every deployment requires human approval after verification. No automatic production releases.',
  ],
  [
    'calendar-decision',
    'Recurring task decision',
    'We agreed skipping a recurring task advances to the next occurrence without marking the task complete.',
  ],
  [
    'budget-decision',
    'Tool context decision',
    'We decided to measure token costs on full rendered search responses, not just snippets.',
  ],
  [
    'permission-decision',
    'Access enforcement decision',
    'We chose to enforce container read permissions before candidate ranking to prevent restricted content leaks.',
  ],
] as const;
export interface EvalQuery {
  id: string;
  intent:
    | 'known file or symbol'
    | 'where handled'
    | 'document concept'
    | 'thread decision'
    | 'table row';
  input: Record<string, unknown>;
  expected: string[];
}
export const queries: EvalQuery[] = [
  ...[
    ['retryPolicy.ts', 'src/retryPolicy.ts'],
    ['calculateBackoff', 'src/retryPolicy.ts'],
    ['permissions.ts', 'src/permissions.ts'],
    ['canReadContainer', 'src/permissions.ts'],
    ['skipOccurrence', 'src/calendar.ts'],
    ['estimateContextBudget', 'src/tokenBudget.ts'],
  ].map(([query, target], i) => ({
    id: `known-${i}`,
    intent: 'known file or symbol' as const,
    input: { kind: 'code', query, code_mode: 'both' },
    expected: [target],
  })),
  ...[
    ['where is exponential retry delay calculated', 'src/retryPolicy.ts'],
    ['where are container read permissions enforced', 'src/permissions.ts'],
    ['where does pausing project indexing stop scans', 'src/fileIndexer.ts'],
    ['where is remaining conversation context calculated', 'src/tokenBudget.ts'],
    ['where is skipping a recurring occurrence handled', 'src/calendar.ts'],
    ['shouldIndexProject', 'src/fileIndexer.ts'],
  ].map(([query, target], i) => ({
    id: `where-${i}`,
    intent: 'where handled' as const,
    input: {
      kind: i === 5 ? 'workspace' : 'files',
      query,
      ...(i === 5 ? { kinds: ['file'] } : {}),
    },
    expected: [target],
  })),
  ...[
    ['request retries with jitter and a maximum delay', 'retry'],
    ['keep private documents out of agent search', 'permissions'],
    ['stop scanning files but keep old search results', 'indexing'],
    ['how much context do tool responses consume', 'tokens'],
    ['skip a repeating task without deleting the schedule', 'calendar'],
    ['what must happen before shipping a release', 'deployment'],
  ].map(([query, target], i) => ({
    id: `concept-${i}`,
    intent: 'document concept' as const,
    input: { kind: 'workspace', kinds: ['doc'], query, mode: 'hybrid' },
    expected: [target],
  })),
  ...[
    ['what did we decide about the retry cap', 'retry-decision'],
    ['why keep search results when indexing is paused', 'index-decision'],
    ['who approved automatic production releases', 'release-decision'],
    ['decision about skipping recurring tasks', 'calendar-decision'],
    ['agreement on measuring search response tokens', 'budget-decision'],
    ['decision to check access before ranking', 'permission-decision'],
  ].map(([query, target], i) => ({
    id: `thread-${i}`,
    intent: 'thread decision' as const,
    input: { kind: 'conversations', query },
    expected: [target],
  })),
];

/**
 * Titles the six `table row` queries search for, in the order of `documents`
 * (`documents[i]` is the expected hit for `row-${i}`). Each is an unambiguous
 * substring of exactly one seeded doc title.
 */
export const tableRowTitleQueries = [
  'Retry policy',
  'Workspace access',
  'File indexing',
  'Context budget',
  'Calendar recurrence',
  'Deployment checklist',
] as const;

/** Name the runner creates the custom Database table under (its physical name). */
export const TABLE_ROW_TABLE_NAME = 'search_eval_docs';

/**
 * The six kind:"database" queries, pointed at a custom Database table whose
 * physical name is `table`. `kind:"database"` reads custom tables only (the
 * `user_tables` schema), so the runner seeds the eval docs into a custom table
 * with a `doc_id` column (holding `doc-<id>`) and the title as the Name
 * (`name`) column. `columns` lists `doc_id` first so the displayed first
 * column is the doc id that `displayedIds` parses; `name` is searched by the
 * title query.
 */
export function tableRowQueries(table: string): EvalQuery[] {
  return tableRowTitleQueries.map((query, i) => ({
    id: `row-${i}`,
    intent: 'table row' as const,
    input: {
      kind: 'database',
      table,
      columns: ['doc_id', 'name'],
      search_columns: ['name'],
      query,
      order_by: 'doc_id',
    },
    expected: [documents[i][0]],
  }));
}
