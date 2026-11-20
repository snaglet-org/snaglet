import { z } from 'zod';
import type { ToolHandler } from '@server/services/ToolService/types';
import { WorkspaceEditDocInput } from './docInputs';
import { assertNotArchived } from '@server/services/ToolService/tools/_shared/archiveGuard';
import { emitDocBodySaved } from '@server/realtime/surfaces/tree';
import { embedDocNow } from '@server/services/embedding/embedDoc';
import { resolveDocByPath } from '@server/services/WorkspaceService/pathResolver';
import { assertNoTransclusionLoop, getDb, transaction } from '@snaglet/db';
import { Docs } from '@snaglet/db/tables/docs';
import { stampDocEdit } from '@server/services/embedding/docSettleReembed';
import { hooks } from '@server/services/HookService';
import { resolveCurrentActorMemberId } from '@server/realtime/actorMember';
import {
  extractCanonicalWorkspaceReferences,
  lintCanonicalWorkspaceReferencesInContent,
} from '@server/services/SocketService/outboundMessageLinter';
import { routeEdits, type RoutedEdit } from '@server/services/transclusions/routeEdits';
import {
  cachedDocLoader,
  listTranscluders,
} from '@server/services/transclusions/transclusionGraph';
import { randomUUID } from 'node:crypto';
import {
  findTransclusions,
  getErrorMessage,
  isoNow,
  lineRefOffsets,
  resolveDocAnchor,
  safeJsonParse,
  transcludedDocIds,
  type DocAnchor,
} from '@snaglet/shared/utils';
const shortId = (len = 8) => randomUUID().replace(/-/g, '').slice(0, len);

/**
 * Agents frequently send `edits` in a shape the schema doesn't literally
 * accept — a single `{old_text, new_text}` object instead of an array, or the
 * whole array as a JSON string. Rather than fail 100% of those calls with a raw
 * Zod dump, coerce the common shapes to the canonical `edits: [...]` array.
 */
function coerceEditsShape(input: Record<string, unknown>): Record<string, unknown> {
  const raw = input.edits;
  let edits: unknown = raw;

  // Whole value passed as a JSON string → parse it first.
  if (typeof edits === 'string') {
    const parsed = safeJsonParse<unknown>(edits, undefined);
    if (parsed !== undefined) edits = parsed;
  }

  // Single edit object → wrap it in an array.
  if (edits && typeof edits === 'object' && !Array.isArray(edits)) {
    edits = [edits];
  }

  return edits === raw ? input : { ...input, edits };
}

/**
 * Turn a Zod validation failure into a self-teaching message. The raw Zod dump
 * (e.g. `{expected:"array",received:"string",path:["edits"]}`) tells agents
 * nothing about how to fix the call; this shows the expected shape and a
 * copyable example.
 */
function friendlyEditDocError(err: z.ZodError): string {
  const touchesEdits = err.issues.some((i) => i.path[0] === 'edits');
  const first = err.issues[0];
  const detail = first ? ` (${first.path.join('.') || 'input'}: ${first.message})` : '';
  if (touchesEdits) {
    return (
      'edit_doc `edits` must be an array of {old_text, new_text} objects — e.g. ' +
      'edits: [{ "old_text": "text to find", "new_text": "replacement" }]. ' +
      'A single {old_text, new_text} object is also accepted (it is wrapped automatically). ' +
      `Optional per-edit keys: occurrence, context_before, context_after.${detail}`
    );
  }
  return `Invalid edit_doc input${detail}`;
}

function parseEditDocInput(input: Record<string, unknown>) {
  try {
    return WorkspaceEditDocInput.parse(coerceEditsShape(input));
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new Error(friendlyEditDocError(err));
    }
    throw err;
  }
}

interface TransclusionWarning {
  edit_index: number;
  doc_id: string;
  message: string;
  affected_docs: Array<{
    doc_id: string;
    title: string;
    action: 'added' | 'removed' | 'part-missing';
  }>;
}

/** True when the part a transclusion names still exists in `content`. */
function partExists(content: string, anchor: DocAnchor): boolean {
  const lines = resolveDocAnchor(content, anchor).lines;
  return lines !== null && lineRefOffsets(content, lines) !== null;
}

interface EditedDoc {
  id: string;
  title: string;
  /** How many docs are known to transclude this one, so show the change too. */
  transcluded_in: number;
  backup_id?: string;
  backup_skipped_reason?: string;
}

interface EditResult {
  success: true;
  doc_id: string;
  edits_applied: RoutedEdit[];
  edited_docs: EditedDoc[];
  /** Set when an edit changed a transcluded doc instead of `doc_id`. */
  message?: string;
  warnings: TransclusionWarning[];
  preview?: Array<{ doc_id: string; title: string; old_content: string; new_content: string }>;
  backup_id?: string;
  backup_skipped_reason?: string;
}

const handler: ToolHandler = async (input, _settings, context) => {
  const result = await editDoc(input, context?.hookOrigin);
  return {
    output: JSON.stringify(result, null, 2),
    rawContent: result,
  };
};

/**
 * Run the batch's transaction. A deadlock with another write (Postgres
 * 40P01: the database rolled this one back) gets the same retryable message
 * as a doc that changed under the edit.
 */
async function writeBatch(fn: Parameters<typeof transaction>[0]): Promise<void> {
  try {
    await transaction(fn);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === '40P01') {
      throw new Error(
        'These docs were being changed by someone else at the same moment; read them again and retry. Nothing was saved.'
      );
    }
    throw err;
  }
}

function routingMessage(
  rootId: string,
  rootTitle: string,
  applied: RoutedEdit[],
  edited: EditedDoc[]
): string | undefined {
  const notes = edited
    .filter((doc) => doc.id !== rootId)
    .map((doc) => {
      const indexes = applied.filter((a) => a.doc_id === doc.id).map((a) => a.index);
      const which = indexes.length === 1 ? `Edit ${indexes[0]}` : `Edits ${indexes.join(', ')}`;
      const shown = doc.transcluded_in === 1 ? '1 doc' : `${doc.transcluded_in} docs`;
      return (
        `${which} changed "${doc.title}" (${doc.id}), not "${rootTitle}": that text belongs ` +
        `to the transcluded doc. It is transcluded in at least ${shown}, so the change shows in each.`
      );
    });
  return notes.length > 0 ? notes.join(' ') : undefined;
}

async function editDoc(
  input: Record<string, unknown>,
  hookOrigin?: { kind: 'hook'; hookName: string }
): Promise<EditResult> {
  const parsed = parseEditDocInput(input);
  const {
    doc_id,
    doc_path,
    edits,
    validate_only = false,
    create_backup = false,
    raw = false,
  } = parsed;

  if (!doc_id && !doc_path) {
    throw new Error('Must specify either doc_id or doc_path');
  }
  if (doc_id && doc_path) {
    throw new Error('Cannot specify both doc_id and doc_path');
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('edits must be a non-empty array');
  }

  // Resolve target doc
  const resolvedDocId: string = doc_path ? await resolveDocByPath(doc_path) : doc_id!;
  const doc = await Docs.findById(resolvedDocId);
  if (!doc) {
    throw new Error(`Document not found: ${doc_path || doc_id}`);
  }
  assertNotArchived(doc, { allow_archived: parsed.allow_archived });

  const pool = getDb();
  const load = cachedDocLoader(pool);
  const routed = await routeEdits({
    root: { id: resolvedDocId, title: doc.title, content: doc.content || '' },
    edits,
    load,
    raw,
  });
  const titleOf = (id: string) => routed.titles.get(id) ?? id;
  const inDoc = (id: string) => (id === resolvedDocId ? '' : ` in "${titleOf(id)}" (${id})`);

  const referenceCounts = (content: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const ref of extractCanonicalWorkspaceReferences(content)) {
      const key = `${ref.id}\u0000${ref.nodeType}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };

  const warnings: TransclusionWarning[] = [];
  for (const [docId, next] of routed.changed) {
    const before = routed.original.get(docId) ?? '';
    const refsBeforeEdit = referenceCounts(before);
    const refsAfterEdit = referenceCounts(next);
    const referenceLint = await lintCanonicalWorkspaceReferencesInContent(next);
    if (referenceLint.infrastructureError) {
      throw new Error('edit_doc: workspace reference validation is temporarily unavailable');
    }
    const newlyInvalidReferences = referenceLint.issues.filter((issue) => {
      const key = `${issue.id}\u0000${issue.nodeType}`;
      return (refsAfterEdit.get(key) ?? 0) > (refsBeforeEdit.get(key) ?? 0);
    });
    if (newlyInvalidReferences.length > 0) {
      const details = newlyInvalidReferences
        .map((issue) => `${issue.id} (${issue.reason.replace('_', ' ')})`)
        .join(', ');
      throw new Error(
        `edit_doc: edit would add unverified workspace reference(s)${inDoc(docId)}: ${details}`
      );
    }

    // Report transclusions this batch adds or removes.
    const beforeIds = new Set(transcludedDocIds(before));
    const afterIds = new Set(transcludedDocIds(next));
    const added = [...afterIds].filter((id) => !beforeIds.has(id));
    const removed = [...beforeIds].filter((id) => !afterIds.has(id));
    if (added.length === 0 && removed.length === 0) continue;
    const found = await load([...added, ...removed]);
    const missing = added.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Edit would transclude nonexistent doc(s)${inDoc(docId)}: ${missing.join(', ')}`
      );
    }
    warnings.push({
      edit_index: -1,
      doc_id: docId,
      message: `Transclusions changed${inDoc(docId)}: ${added.length} added, ${removed.length} removed`,
      affected_docs: [
        ...added.map((id) => ({
          doc_id: id,
          title: found.get(id)?.title ?? '<missing>',
          action: 'added' as const,
        })),
        ...removed.map((id) => ({
          doc_id: id,
          title: found.get(id)?.title ?? '<missing>',
          action: 'removed' as const,
        })),
      ],
    });
  }

  // A doc shown in part (`![](doc-…#h=setup)`) by this doc or any other: a
  // change that removes that heading or those lines leaves the part missing.
  // The links graph can miss a transcluder (a label with escaped brackets,
  // or one written before this doc was archived and restored), so the doc
  // edited through and every doc in the batch are always checked as well.
  const batch = new Map(routed.changed);
  if (!batch.has(resolvedDocId)) batch.set(resolvedDocId, doc.content || '');
  const transcluders = new Map<string, number>();
  for (const [docId, next] of routed.changed) {
    const before = routed.original.get(docId) ?? '';
    const sources = new Map<string, { title: string; content: string }>();
    for (const src of await listTranscluders(pool, docId)) sources.set(src.id, src);
    for (const [id, content] of batch) {
      if (id !== docId && transcludedDocIds(content).includes(docId)) {
        sources.set(id, { title: titleOf(id), content });
      }
    }
    transcluders.set(docId, sources.size);
    for (const [srcId, src] of sources) {
      const fragments = new Set<string>();
      for (const hit of findTransclusions(src.content)) {
        if (hit.docId !== docId || !hit.anchor) continue;
        if (!partExists(before, hit.anchor) || partExists(next, hit.anchor)) continue;
        fragments.add(hit.ref.slice(hit.ref.indexOf('#') + 1));
      }
      for (const fragment of fragments) {
        warnings.push({
          edit_index: -1,
          doc_id: srcId,
          message:
            `"${src.title}" (${srcId}) transcludes the "${fragment}" part of "${titleOf(docId)}" ` +
            `(${docId}), which this edit removes, so it now shows as missing. Restore it, or ` +
            'change that transclusion line with raw: true.',
          affected_docs: [{ doc_id: docId, title: titleOf(docId), action: 'part-missing' }],
        });
      }
    }
  }

  const edited: EditedDoc[] = [];
  for (const docId of routed.changed.keys()) {
    edited.push({
      id: docId,
      title: titleOf(docId),
      transcluded_in: transcluders.get(docId) ?? 0,
    });
  }
  const message = routingMessage(resolvedDocId, doc.title, routed.applied, edited);

  const assertNoLoops = async (runner: Parameters<typeof assertNoTransclusionLoop>[0]) => {
    for (const entry of edited) {
      await assertNoTransclusionLoop(
        runner,
        {
          id: entry.id,
          title: entry.title,
          content: routed.changed.get(entry.id) ?? '',
          previous: routed.original.get(entry.id) ?? '',
        },
        routed.changed
      );
    }
  };

  // Preview / validate-only: report the routing, write nothing.
  if (validate_only) {
    await assertNoLoops(pool);
    return {
      success: true,
      doc_id: resolvedDocId,
      edits_applied: routed.applied,
      edited_docs: edited,
      ...(message ? { message } : {}),
      warnings,
      preview: edited.map((d) => ({
        doc_id: d.id,
        title: d.title,
        old_content: routed.original.get(d.id) ?? '',
        new_content: routed.changed.get(d.id) ?? '',
      })),
    } satisfies EditResult;
  }

  // Persist every doc the batch touches in one transaction: one failure
  // writes nothing. Content goes in with raw SQL (careful anchor-based
  // splicing + snapshotting), bypassing DocModel.update's chokepoint, so
  // last_edited_by is stamped inline with the acting member's members.id.
  const editedBy = await resolveCurrentActorMemberId();
  const updatedAt = new Map<string, string>();
  await writeBatch(async (tx) => {
    // The edits were computed from the text read before; a person typing in
    // one of these docs, or an archive or delete, may have changed it since.
    // Lock the rows and check, so no one's newer text is overwritten. Nodes
    // first, as a delete (nodes, then docs by cascade) and an archive do, so
    // the two can't deadlock and an archive can't land between check and write.
    const ids = edited.map((entry) => entry.id);
    const { rows: nodeRows } = await tx.query<{ id: string; archived: boolean | null }>(
      `SELECT id, archived FROM nodes WHERE id = ANY($1) ORDER BY id FOR NO KEY UPDATE`,
      [ids]
    );
    const { rows: docRows } = await tx.query<{ id: string; content: string | null }>(
      `SELECT id, content FROM docs WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
      [ids]
    );
    const archived = new Map(nodeRows.map((row) => [row.id, row.archived === true]));
    const now = new Map(docRows.map((row) => [row.id, row]));
    for (const entry of edited) {
      const row = now.get(entry.id);
      const archivedNow =
        archived.get(entry.id) === true && !(entry.id === resolvedDocId && parsed.allow_archived);
      if (!row || archivedNow || (row.content ?? '') !== routed.original.get(entry.id)) {
        const what = !row ? 'was deleted' : archivedNow ? 'was archived' : 'changed';
        throw new Error(
          `"${entry.title}" (${entry.id}) ${what} since this edit read it; read it again and retry. Nothing was saved.`
        );
      }
    }
    for (const entry of edited) {
      const before = routed.original.get(entry.id) ?? '';
      if (create_backup) {
        // A failed snapshot must not fail the edit; the savepoint keeps the
        // transaction usable after it.
        await tx.query('SAVEPOINT edit_doc_backup');
        try {
          const snapId = `snap-${Date.now()}-${shortId(8)}`;
          await tx.query(
            `INSERT INTO doc_snapshots
                (id, doc_id, content, content_bytes, label, reason)
              VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              snapId,
              entry.id,
              before,
              Buffer.byteLength(before, 'utf8'),
              'pre-edit',
              `Auto-snapshot before edit_doc with ${edits.length} edit(s)`,
            ]
          );
          await tx.query('RELEASE SAVEPOINT edit_doc_backup');
          entry.backup_id = snapId;
        } catch (err) {
          await tx.query('ROLLBACK TO SAVEPOINT edit_doc_backup');
          entry.backup_skipped_reason = `Auto-snapshot failed: ${getErrorMessage(err)}`;
        }
      }
      await tx.query(`UPDATE docs SET content = $1, last_edited_by = $3 WHERE id = $2`, [
        routed.changed.get(entry.id),
        entry.id,
        editedBy,
      ]);
      // Bump the canonical updated_at on the node spine so list_recent and
      // similar tools see the change.
      const ts = await tx.query<{ updated_at: string }>(
        `UPDATE nodes SET updated_at = NOW() WHERE id = $1 RETURNING updated_at`,
        [entry.id]
      );
      updatedAt.set(entry.id, ts.rows[0]?.updated_at ?? isoNow());
    }
    // Checked against the written state, so a loop rolls the whole batch back.
    await assertNoLoops(tx);
  });

  // Each doc is announced exactly as if it had been edited directly.
  for (const entry of edited) {
    const next = routed.changed.get(entry.id) ?? '';
    emitDocBodySaved(entry.id, next, updatedAt.get(entry.id) ?? isoNow(), editedBy);
    hooks.emit('doc:edit', {
      id: entry.id,
      editor: editedBy,
      charsDelta: next.length - (routed.original.get(entry.id) ?? '').length,
      backupSnapshotId: entry.backup_id ?? null,
      ...(hookOrigin ? { origin: hookOrigin } : {}),
    });
    // Agent edits are discrete, complete writes — embed immediately (the human
    // autosave path defers to the sweep). Read the title back so the blob/hash
    // matches the sweep + create paths, and advance the settle-state's
    // embedded marker so the sweep doesn't embed the same content again.
    const savedDoc = await Docs.findById(entry.id);
    if (savedDoc) {
      embedDocNow(savedDoc.id, savedDoc.title, savedDoc.content);
      void stampDocEdit(savedDoc.id, savedDoc.title, savedDoc.content, {
        alreadyEmbedded: true,
      });
    }
  }

  const rootEntry = edited.find((d) => d.id === resolvedDocId);
  return {
    success: true,
    doc_id: resolvedDocId,
    edits_applied: routed.applied,
    edited_docs: edited,
    ...(message ? { message } : {}),
    warnings,
    ...(rootEntry?.backup_id ? { backup_id: rootEntry.backup_id } : {}),
    ...(rootEntry?.backup_skipped_reason
      ? { backup_skipped_reason: rootEntry.backup_skipped_reason }
      : {}),
  };
}

export default handler;
