/**
 * Who transcludes whom, read from doc content. The `links` table can't answer
 * this: it records links and transclusions alike, and it skips a target that
 * did not exist yet when the source was saved.
 */

import type { DbQueryable } from '@snaglet/db';
import { transcludedDocIds } from '@snaglet/shared/utils';
import { extractNodeRefIds } from '@server/services/WorkspaceService/markdownRefs';
import type { TranscludableDoc, TranscludableDocLoader } from './expandTransclusions';

export interface DocSummary {
  id: string;
  title: string;
}

/** What a doc read lists for each doc it transcludes. */
export type TransclusionSummary =
  | DocSummary
  | (DocSummary & { archived: true })
  | { id: string; missing: true };

async function loadTranscludableDocs(
  runner: DbQueryable,
  ids: readonly string[]
): Promise<Map<string, TranscludableDoc>> {
  const out = new Map<string, TranscludableDoc>();
  if (ids.length === 0) return out;
  const { rows } = await runner.query<{
    id: string;
    title: string;
    content: string | null;
    archived: boolean | null;
  }>(
    `SELECT d.id, d.title, d.content, n.archived
       FROM docs d
       JOIN nodes n ON n.id = d.id
      WHERE d.id = ANY($1)`,
    [ids]
  );
  for (const row of rows) {
    out.set(row.id, {
      id: row.id,
      title: row.title,
      content: row.content ?? '',
      archived: row.archived === true,
    });
  }
  return out;
}

/** A loader that reads each doc once, with `pending` contents winning over stored ones. */
export function cachedDocLoader(
  runner: DbQueryable,
  pending?: ReadonlyMap<string, string>
): TranscludableDocLoader {
  const cache = new Map<string, TranscludableDoc | null>();
  return async (ids) => {
    const missing = ids.filter((id) => !cache.has(id));
    if (missing.length > 0) {
      const found = await loadTranscludableDocs(runner, missing);
      for (const id of missing) cache.set(id, found.get(id) ?? null);
    }
    const out = new Map<string, TranscludableDoc>();
    for (const id of ids) {
      const doc = cache.get(id);
      if (!doc) continue;
      const content = pending?.get(id);
      out.set(id, content === undefined ? doc : { ...doc, content });
    }
    return out;
  };
}

/** The docs `content` transcludes directly, in order of first appearance. */
export async function listTransclusions(
  content: string,
  load: TranscludableDocLoader
): Promise<TransclusionSummary[]> {
  const ids = transcludedDocIds(content);
  if (ids.length === 0) return [];
  const docs = await load(ids);
  return ids.map((id) => {
    const doc = docs.get(id);
    if (!doc) return { id, missing: true as const };
    return doc.archived
      ? { id, title: doc.title, archived: true as const }
      : { id, title: doc.title };
  });
}

/**
 * Unarchived docs that transclude `docId`, with their content, from the links
 * graph. That graph misses a transclusion whose label has escaped or nested
 * brackets (the link trigger can't read it) and one written before `docId`
 * was archived and restored (archiving drops links into a doc), so callers
 * treat the list as "at least".
 */
export async function listTranscluders(
  runner: DbQueryable,
  docId: string
): Promise<Array<DocSummary & { content: string }>> {
  const { rows } = await runner.query<{ id: string; title: string; content: string | null }>(
    `SELECT d.id, d.title, d.content
       FROM links l
       JOIN docs d ON d.id = l.source_id
       JOIN nodes n ON n.id = d.id
      WHERE l.target_id = $1
        AND l.relation = 'references'
        AND l.source_id <> $1
        AND n.archived = false`,
    [docId]
  );
  return rows
    .map((row) => ({ id: row.id, title: row.title, content: row.content ?? '' }))
    .filter((row) => transcludedDocIds(row.content).includes(docId));
}

export interface Referrer extends DocSummary {
  archived?: true;
}

const likeEscape = (value: string) => value.replace(/([\\%_])/g, '\\$1');

/**
 * Every other doc that refers to `docId`, split into the docs that transclude
 * it and the ones that only link to it, each sorted by title; archived docs
 * included and flagged. Found by scanning content for the id, not through the
 * `links` graph: archiving a doc drops the links into it (a restore rebuilds
 * only its own), and the link trigger can't read labels with escaped or
 * nested brackets. Each candidate's content is parsed, code ignored, to say
 * whether it transcludes the doc, links to it, or neither.
 */
export async function listReferrers(
  runner: DbQueryable,
  docId: string
): Promise<{ transcluded_in: Referrer[]; linked_from: Referrer[] }> {
  const { rows } = await runner.query<{
    id: string;
    title: string;
    content: string | null;
    archived: boolean | null;
  }>(
    `SELECT d.id, d.title, d.content, n.archived
       FROM docs d
       JOIN nodes n ON n.id = d.id
      WHERE d.id <> $1
        AND d.content LIKE $2 ESCAPE '\\'`,
    [docId, `%${likeEscape(docId)}%`]
  );
  const out = { transcluded_in: [] as Referrer[], linked_from: [] as Referrer[] };
  for (const row of rows) {
    const content = row.content ?? '';
    const entry: Referrer = {
      id: row.id,
      title: row.title,
      ...(row.archived ? { archived: true as const } : {}),
    };
    if (transcludedDocIds(content).includes(docId)) out.transcluded_in.push(entry);
    else if (extractNodeRefIds(content).has(docId)) out.linked_from.push(entry);
  }
  out.transcluded_in.sort((a, b) => a.title.localeCompare(b.title));
  out.linked_from.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

/** At most this many docs are listed as transcluding a doc; the total is always given. */
export const TRANSCLUDED_IN_LIMIT = 20;

/** Unarchived docs that transclude `docId`, sorted by title, the first TRANSCLUDED_IN_LIMIT of them. */
export async function listTranscludedIn(
  runner: DbQueryable,
  docId: string
): Promise<{ docs: DocSummary[]; total: number }> {
  const all = (await listTranscluders(runner, docId))
    .map(({ id, title }) => ({ id, title }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return { docs: all.slice(0, TRANSCLUDED_IN_LIMIT), total: all.length };
}
