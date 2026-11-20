/**
 * The save-time transclusion loop guard. A doc may not transclude itself or
 * any doc that transcludes it, directly or through a chain. Every doc content
 * write calls this: DocModel.create/update here, and the raw-SQL writers
 * (doc update edit routing, clone) with their own transaction.
 *
 * Only transclusions a save adds are followed. A loop already in stored data
 * does not block unrelated edits to the docs in it; reads show it as a marker
 * and never expand it.
 */

import { AppError, transcludedDocIds } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';
import type { DbQueryable } from '@snaglet/db/db';

export interface TransclusionLoopStep {
  id: string;
  title: string;
}

async function loadDocs(
  runner: DbQueryable,
  ids: readonly string[]
): Promise<Map<string, { title: string; content: string }>> {
  const out = new Map<string, { title: string; content: string }>();
  if (ids.length === 0) return out;
  const { rows } = await runner.query<{ id: string; title: string; content: string | null }>(
    `SELECT id, title, content FROM public.docs WHERE id = ANY($1)`,
    [ids]
  );
  for (const row of rows) out.set(row.id, { title: row.title, content: row.content ?? '' });
  return out;
}

/**
 * The chain from `docId` back to itself that transcluding `targets` would
 * close, shortest first, or null. `pending` holds other docs' unsaved
 * contents, which win over stored ones.
 */
export async function findTransclusionLoop(
  runner: DbQueryable,
  docId: string,
  targets: readonly string[],
  opts: { title?: string; pending?: ReadonlyMap<string, string> } = {}
): Promise<TransclusionLoopStep[] | null> {
  const parent = new Map<string, string>();
  let path: string[] | null = null;
  let frontier: string[] = [];
  for (const target of targets) {
    if (target === docId) {
      path = [docId, docId];
      break;
    }
    if (!parent.has(target)) {
      parent.set(target, docId);
      frontier.push(target);
    }
  }
  while (!path && frontier.length > 0) {
    const stored = await loadDocs(
      runner,
      frontier.filter((id) => !opts.pending?.has(id))
    );
    const next: string[] = [];
    for (const id of frontier) {
      const content = opts.pending?.get(id) ?? stored.get(id)?.content;
      if (content === undefined) continue;
      for (const target of transcludedDocIds(content)) {
        if (target === docId) {
          const chain = [id];
          while (chain[0] !== docId) chain.unshift(parent.get(chain[0]!)!);
          path = [...chain, docId];
          break;
        }
        if (!parent.has(target)) {
          parent.set(target, id);
          next.push(target);
        }
      }
      if (path) break;
    }
    frontier = next;
  }
  if (!path) return null;
  const titles = await loadDocs(runner, [...new Set(path)]);
  return path.map((id) => ({
    id,
    title: (id === docId ? opts.title : undefined) ?? titles.get(id)?.title ?? id,
  }));
}

/**
 * Refuse a save of `content` to `doc.id` that would create a transclusion
 * loop. `previous` is the doc's content before this save; omitted, it is read
 * from the database (an unknown doc counts as empty).
 */
export async function assertNoTransclusionLoop(
  runner: DbQueryable,
  doc: { id: string; content: string; previous?: string | null; title?: string },
  pending?: ReadonlyMap<string, string>
): Promise<void> {
  const targets = transcludedDocIds(doc.content);
  if (targets.length === 0) return;
  let previous = doc.previous;
  if (previous === undefined) {
    previous = (await loadDocs(runner, [doc.id])).get(doc.id)?.content ?? null;
  }
  const before = new Set(transcludedDocIds(previous ?? ''));
  const added = targets.filter((id) => !before.has(id));
  if (added.length === 0) return;
  const loop = await findTransclusionLoop(runner, doc.id, added, {
    ...(doc.title !== undefined ? { title: doc.title } : {}),
    ...(pending ? { pending } : {}),
  });
  if (!loop) return;
  throw new AppError(
    `Transclusion loop: ${loop.map((s) => `"${s.title}" (${s.id})`).join(' → ')}. ` +
      'A doc cannot transclude itself or any doc that transcludes it, so nothing was saved.',
    ErrorCode.CONFLICT,
    409,
    true,
    { transclusionLoop: loop }
  );
}
