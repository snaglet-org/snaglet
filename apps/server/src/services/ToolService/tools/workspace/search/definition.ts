import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

/**
 * The schema lists only the fields agents use. `graph_depth`, `thread_id`,
 * `archived_only`, `since`, `container_path`, the database
 * fields (`table`, `columns`, `search_columns`, `filters`, `order_by`,
 * `order_direction`, `offset`), the scoping fields (`container_id`, `name`,
 * `project_id`, `include_archived`) and the file/code options (`scope_files`,
 * `code_mode`, `glob`) are not listed but are still accepted:
 * nothing validates input against this schema, and the handlers read them
 * from `input`. Their schemas are in `unlisted_params` (returned by
 * tool op:schema) and documented in TOOL.md.
 */
const definition: BuiltinToolDefinition = {
  id: 'search',
  name: 'Search',
  description:
    "Your recall for everything outside this thread's visible turns: search workspace knowledge (docs, messages, memories, thread summaries, threads), containers, code, files, database tables and past conversations, or fetch nodes by id.\n" +
    "• Discover: `query` (+ `kinds`, `mode`, `time_range`). `mode` defaults to `hybrid` (meaning + keywords); use `mode: 'keyword'` for exact strings, ids, symbols, literal titles.\n" +
    "• Resolve: `id`/`ids` (≤20) for known nodes; `detail: 'full'` returns a doc's body.\n" +
    '• Quote: `query` to find the item, then `id` + `content_range` re-reads the CURRENT source and returns only those lines. Snippets show where to look; quote only from a ranged read.\n' +
    'Empty results mean "nothing matched", not "nothing exists" — rephrase, broaden `kinds` or change `mode` first.\n' +
    'Scoping (container_id, project_id…), file, database and table-row fields are not listed: tool({op:"schema", name:"search"}) returns them as unlisted_parameters.',
  type: 'builtin',
  tier: 'core',
  keywords: [
    'workspace',
    'search',
    'docs',
    'threads',
    'containers',
    'full-text',
    'lexical',
    'find',
    'snippet',
    'tsvector',
  ],
  parameters_schema: {
    type: 'object',
    required: [],
    properties: {
      kind: {
        type: 'string',
        enum: [
          'all',
          'workspace',
          'docs',
          'containers',
          'code',
          'files',
          'database',
          'conversations',
        ],
        default: 'all',
        description:
          'Backend. `all`/`workspace` = fused workspace search; `database` reads one custom table (`user_tables` only) via unlisted fields (table, columns, filters, order_by…).',
      },
      query: {
        type: 'string',
        description:
          'Search text. Docs/messages/memories use web-search syntax; threads/containers match names by substring. A literal node id resolves directly.',
      },
      id: {
        type: 'string',
        description:
          'Exact node id to fetch directly, such as `doc-…`, `thread-…`, `memory-…`, a container UUID, or a tool id. `doc-…#L12-L20`, `#h=slug` read that part.',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Exact ids to fetch directly. Duplicate ids are ignored; at most 20 are resolved per call.',
      },
      detail: {
        type: 'string',
        enum: ['compact', 'preview', 'full'],
        default: 'compact',
        description: "For id lookups. `full` = a doc's full body.",
      },
      content_range: {
        type: 'object',
        description:
          'Lines to return from CURRENT content (1-indexed, INCLUSIVE) for doc, message, memory and text file. ≤500 lines per range; with `query` only the top 5 results (limit>5 is rejected). Truncation is stated; page with further calls.',
        properties: {
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
        },
        required: ['start_line', 'end_line'],
      },
      kinds: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'container',
            'doc',
            'thread',
            'memory',
            'thread_summary',
            'message',
            'tool',
            'image',
            'file',
            'entry',
          ],
        },
        description:
          'Node kinds to search. `["entry"]` alone searches table rows: see `table`, `filters`, `sort`. Default: every kind except `file`; pass `["file"]` for files (code-like queries also add a labeled file section).',
      },
      mode: {
        type: 'string',
        enum: ['hybrid', 'semantic', 'keyword'],
        description:
          'Default `hybrid`. `keyword` = lexical with name/title/path fallback. Semantic covers doc/message/memory/thread_summary/file; threads and containers are keyword-only.',
      },
      time_range: {
        type: 'object',
        description:
          'Explicit date window. Omit it to let date phrases in `query` apply ("yesterday", "last week", "in q3", "created yesterday", "updated last week"); "recently"/"lately" only boost the last 30 days.',
        properties: {
          from: { type: 'string', description: 'Inclusive ISO date/time.' },
          to: { type: 'string', description: 'Exclusive ISO date/time.' },
          mode: { type: 'string', enum: ['filter', 'boost'], default: 'filter' },
          field: {
            type: 'string',
            enum: ['activity_at', 'created_at', 'updated_at'],
            default: 'activity_at',
          },
        },
      },
      path: {
        type: 'string',
        description: 'Restrict to the subtree at this path, e.g. `/Snaglet/docs`.',
      },
      project_scope: {
        type: 'string',
        enum: ['prioritize', 'only', 'all'],
        default: 'prioritize',
        description:
          '`only` keeps the search to this thread\'s project (docs, threads, messages; no memories or rows). Otherwise it searches everywhere; for kind:"conversations", `prioritize` lists this project first.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Max results per node kind (default 10).',
      },
      sort: {
        type: 'string',
        enum: ['relevance', 'recent'],
        default: 'relevance',
        description:
          '`recent` lists recently updated docs/containers; with kinds ["entry"] it orders matching table rows newest first.',
      },
    },
  },
  unlisted_params: {
    include_archived: {
      type: 'boolean',
      default: false,
      description:
        'Include archived nodes (excluded by default); they are listed first and marked [ARCHIVED].',
    },
    container_id: { type: 'string', description: "Restrict to this container's subtree." },
    name: { type: 'string', description: 'Restrict to the container with this name.' },
    scope_files: {
      type: 'string',
      enum: ['project', 'workspace'],
      default: 'project',
      description:
        "File hits: `project` (default; project_id or this thread's project; workspace-wide if it has no folder) or `workspace`.",
    },
    project_id: {
      type: 'string',
      description: 'Project id: scopes file hits and kinds ["entry"] (its tables\' rows).',
    },
    code_mode: {
      type: 'string',
      enum: ['name', 'content', 'both'],
      default: 'both',
      description: 'Filename/content matching mode for kind:"code".',
    },
    glob: { type: 'string', description: 'Optional file glob for kind:"files".' },
    graph_depth: {
      type: 'integer',
      minimum: 0,
      maximum: 1,
      default: 0,
      description:
        'Semantic/hybrid only: backfill empty slots with 1-hop link neighbors of the top hits (0.6 score decay). Keep 0 unless exploring; hub nodes add noise.',
    },
    thread_id: {
      type: 'string',
      description: 'Semantic/hybrid only: boost results directly connected to this thread.',
    },
    archived_only: {
      type: 'boolean',
      default: false,
      description: 'List archived nodes only.',
    },
    since: { type: 'string', description: 'ISO lower bound for sort:"recent".' },
    container_path: { type: 'string', description: 'Container path scope for sort:"recent".' },
    table: {
      type: 'string',
      description:
        'kinds ["entry"]: search one table by name. kind:"database": a custom Database table name, read as the read-only tables reader (the `user_tables` schema only; workspace tables, credentials and catalog relations are refused).',
    },
    columns: {
      type: 'array',
      items: { type: 'string' },
      description: 'Columns returned for kind:"database".',
    },
    search_columns: {
      type: 'array',
      items: { type: 'string' },
      description: 'Columns searched by query for kind:"database".',
    },
    filters: {
      type: ['array', 'object'],
      description:
        'kinds ["entry"]: [{field, operator, value}] conditions on `table`. kind:"database": exact column filters (object).',
    },
    order_by: { type: 'string', description: 'Sort column for kind:"database".' },
    order_direction: {
      type: 'string',
      enum: ['asc', 'desc'],
      default: 'asc',
      description: 'Database sort direction.',
    },
    match_tables: {
      type: 'boolean',
      default: true,
      description:
        'kinds ["entry"] without `table`: rank tables by name, fields and select options first and search only the best 3 (default). false searches up to 40 tables.',
    },
    offset: { type: 'integer', minimum: 0, default: 0, description: 'Database row offset.' },
  },
  sort_order: 2,
};

export default definition;
