import type { ToolHandler } from '@server/services/ToolService/types';
import {
  formatHeadingFragment,
  resolveDocAnchor,
  sliceLineRef,
  splitDocRef,
} from '@snaglet/shared/utils';
import getDoc from '@server/services/ToolService/handlers/docs/getDoc';
import outlineDoc from '@server/services/ToolService/handlers/docs/outlineDoc';
import createDoc from '@server/services/ToolService/handlers/docs/createDoc';
import editDoc from '@server/services/ToolService/handlers/docs/editDoc';
import deleteDoc from '@server/services/ToolService/handlers/docs/deleteDoc';

import duplicateDoc from '@server/services/ToolService/handlers/docs/duplicateDoc';
import diffDoc from '@server/services/ToolService/handlers/docs/diffDoc';
import convertDocToContainer from '@server/services/ToolService/handlers/docs/convertDocToContainer';
import snapshot from '@server/services/ToolService/handlers/docs/history/snapshot';
import listSnapshots from '@server/services/ToolService/handlers/docs/history/list';
import restoreSnapshot from '@server/services/ToolService/handlers/docs/history/restore';
import deleteSnapshot from '@server/services/ToolService/handlers/docs/history/delete';
import { resolveDocByPath } from '@server/services/WorkspaceService/pathResolver';

type Input = Record<string, unknown>;

const defined = (entries: Input): Input =>
  Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));

/**
 * The fields each op reads. A field that belongs only to other ops is refused
 * before any handler runs, so a call can never half-mean another op (e.g.
 * `force` on an update, `edits` on a create). Unknown fields pass through to
 * the handler.
 */
const OP_FIELDS: Record<string, readonly string[]> = {
  get: ['id', 'doc_id', 'path', 'doc_path', 'raw', 'include_archived'],
  outline: ['id', 'doc_id', 'path', 'doc_path', 'include_archived'],
  create: [
    'title',
    'content',
    'parent_id',
    'parent_path',
    'container_id',
    'container_path',
    'container',
    'parent',
    'container_name',
    'parent_name',
    'sort_order',
  ],
  update: [
    'id',
    'doc_id',
    'path',
    'doc_path',
    'edits',
    'validate_only',
    'create_backup',
    'allow_archived',
    'raw',
  ],
  delete: ['id', 'doc_id', 'path', 'doc_path', 'force', 'dry_run'],
  duplicate: [
    'id',
    'doc_id',
    'path',
    'doc_path',
    'source_id',
    'source_path',
    'new_title',
    'target_container_id',
    'target_container_path',
    'sort_order',
    'allow_archived',
  ],
  diff: [
    'id',
    'doc_id',
    'path',
    'doc_path',
    'from_snapshot_id',
    'to_snapshot_id',
    'from_content',
    'context_lines',
    'max_diff_bytes',
  ],
  snapshot: ['id', 'doc_id', 'path', 'doc_path', 'label', 'reason', 'allow_archived'],
  'list-snapshots': ['id', 'doc_id', 'path', 'doc_path', 'label', 'limit', 'include_content'],
  restore: [
    'id',
    'doc_id',
    'path',
    'doc_path',
    'snapshot_id',
    'label',
    'create_safety_snapshot',
    'validate_only',
  ],
  'delete-snapshot': ['id', 'doc_id', 'path', 'doc_path', 'snapshot_id'],
  'convert-to-container': ['id', 'doc_id', 'path', 'doc_path', 'category'],
};

function refuseForeignFields(op: string, input: Input): void {
  const own = new Set(OP_FIELDS[op]);
  for (const [otherOp, fields] of Object.entries(OP_FIELDS)) {
    if (otherOp === op) continue;
    for (const field of fields) {
      if (!own.has(field) && input[field] !== undefined) {
        throw new Error(
          `doc ${op}: \`${field}\` belongs to op ${otherOp}, not ${op}. Nothing was changed.`
        );
      }
    }
  }
}

// get_doc's handler returned its result object; the executor serialized it.
// A partial-doc link as the id returns only that part: line links
// (`doc-…#L12-L20`) or heading links (`doc-…#h=rate-limits`, `#h3=…`), with
// `lines` saying what was served so the caller never mistakes a slice for
// the whole doc. Parts are cut from the stored source, whose line numbers
// are the ones links use, so transclusions inside a part stay unexpanded.
const get: ToolHandler = async (input) => {
  const { id: bareId, anchor } =
    typeof input.id === 'string' ? splitDocRef(input.id) : { id: input.id, anchor: null };
  // A part read skips who transcludes the doc: it costs a lookup and is about
  // the whole doc, not the part.
  const doc = await getDoc(
    defined({
      doc_id: bareId,
      doc_path: input.path,
      raw: anchor ? true : input.raw,
      include_archived: input.include_archived,
    }) as Parameters<typeof getDoc>[0],
    { transcludedIn: !anchor }
  );
  if (!anchor) return JSON.stringify(doc);
  const content = doc.content ?? '';
  const resolved = resolveDocAnchor(content, anchor);
  const heading = 'heading' in anchor ? { heading: formatHeadingFragment(anchor.heading) } : {};
  if (!resolved.lines) {
    return JSON.stringify({
      ...doc,
      content: '',
      lines: { ref: input.id, ...heading, found: false, note: resolved.note },
    });
  }
  const lines = resolved.lines;
  const slice = sliceLineRef(content, lines);
  const note =
    resolved.note ??
    (slice.outOfRange
      ? `The doc has ${slice.totalLines} lines; nothing at line ${lines.startLine}.`
      : slice.clamped
        ? `Clamped to the doc's last line (${slice.totalLines}).`
        : undefined);
  return JSON.stringify({
    ...doc,
    content: slice.text,
    lines: {
      ref: input.id,
      ...heading,
      start_line: slice.startLine,
      end_line: slice.endLine,
      total_lines: slice.totalLines,
      ...(lines.startChar != null ? { start_char: lines.startChar, end_char: lines.endChar } : {}),
      ...(note ? { note } : {}),
    },
  });
};

// The headings of the stored source with their lines and anchors; an id with
// a part fragment outlines the whole doc.
const outline: ToolHandler = async (input) => {
  const id = typeof input.id === 'string' ? splitDocRef(input.id).id : input.id;
  return JSON.stringify(
    await outlineDoc(
      defined({
        doc_id: id,
        doc_path: input.path,
        include_archived: input.include_archived,
      }) as Parameters<typeof outlineDoc>[0]
    )
  );
};

const create: ToolHandler = (input, settings, context) => {
  const { op: _op, ...rest } = input;
  return createDoc(rest, settings, context);
};

const update: ToolHandler = (input, settings, context) =>
  editDoc(
    defined({
      doc_id: input.id,
      doc_path: input.path,
      edits: input.edits,
      validate_only: input.validate_only,
      create_backup: input.create_backup,
      allow_archived: input.allow_archived,
      raw: input.raw,
    }),
    settings,
    context
  );

const remove: ToolHandler = (input, settings, context) =>
  deleteDoc(
    defined({
      doc_id: input.id,
      doc_path: input.path,
      force: input.force,
      dry_run: input.dry_run,
    }),
    settings,
    context
  );

// Retain each existing handler's own validation, result envelope and errors.
const forward =
  (handler: ToolHandler, fields: readonly string[], resolvePath = false): ToolHandler =>
  async (input, settings, context) => {
    let id = input.id ?? input.doc_id;
    const path = input.path ?? input.doc_path;
    if (resolvePath && path !== undefined) {
      if (id !== undefined) throw new Error('Cannot specify both doc_id and doc_path');
      id = await resolveDocByPath(path as string);
    }
    return handler(
      defined({
        doc_id: id,
        ...(!resolvePath ? { doc_path: path } : {}),
        ...Object.fromEntries(fields.map((field) => [field, input[field]])),
      }),
      settings,
      context
    );
  };

const duplicate: ToolHandler = (input, settings, context) =>
  duplicateDoc(
    defined({
      source_id: input.id ?? input.doc_id ?? input.source_id,
      source_path: input.path ?? input.doc_path ?? input.source_path,
      ...Object.fromEntries(
        [
          'new_title',
          'target_container_id',
          'target_container_path',
          'sort_order',
          'allow_archived',
        ].map((field) => [field, input[field]])
      ),
    }),
    settings,
    context
  );

const OPS: Record<string, ToolHandler> = {
  get,
  outline,
  create,
  update,
  delete: remove,
  duplicate,
  diff: forward(
    diffDoc,
    ['from_snapshot_id', 'to_snapshot_id', 'from_content', 'context_lines', 'max_diff_bytes'],
    true
  ),
  snapshot: forward(snapshot, ['label', 'reason', 'allow_archived']),
  'list-snapshots': forward(listSnapshots, ['label', 'limit', 'include_content']),
  restore: forward(
    restoreSnapshot,
    ['snapshot_id', 'label', 'create_safety_snapshot', 'validate_only'],
    true
  ),
  'delete-snapshot': forward(deleteSnapshot, ['snapshot_id'], true),
  'convert-to-container': forward(convertDocToContainer, ['category'], true),
};

/**
 * doc(op): one core noun tool over the doc and history handlers.
 * Each op builds exactly the input its handler validates.
 */
const tool: ToolHandler = async (input, settings, context) => {
  const op = typeof input.op === 'string' ? input.op : undefined;
  const handler = op ? OPS[op] : undefined;
  if (!op || !handler) {
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(' | ')}.`);
  }
  refuseForeignFields(op, input);
  return handler(
    { ...input, id: input.id ?? input.doc_id, path: input.path ?? input.doc_path },
    settings,
    context
  );
};

export default tool;
