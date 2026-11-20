/**
 * Snaglet items for relation-field tests: one of every allowlisted kind (plus the
 * look-alikes each kind must refuse), written straight to the database with
 * neutral placeholder ids and titles.
 */
import { getDb, quoteIdentifier } from '@snaglet/db';

export const PROJECT = 'container-1111111111111-aaaaaaaaa';
export const FOLDER = 'container-1111111111111-bbbbbbbbb';
export const DOC_A = 'doc-1111111111111-aaaaaaaaa';
export const DOC_B = 'doc-1111111111111-bbbbbbbbb';
export const DOC_ARCHIVED = 'doc-1111111111111-ccccccccc';
export const DOC_TEMPLATE = 'doc-1111111111111-ddddddddd';
export const THREAD = 'thread-1111111111111-aaaaaaaaa';
export const IMAGE = 'image-1111111111111-aaaaaaaaa';
export const AGENT_A = 'test-agent-a';
export const AGENT_B = 'test-agent-b';
export const AGENT_ARCHIVED = 'test-agent-c';
export const MISSING_DOC = 'doc-1111111111111-zzzzzzzzz';

/** Children before their containers and parents. */
const NODES = [DOC_A, DOC_B, DOC_ARCHIVED, DOC_TEMPLATE, THREAD, IMAGE, PROJECT, FOLDER];
const AGENTS = [AGENT_A, AGENT_B, AGENT_ARCHIVED];

/** Titles each fixture reads as. */
export const TITLES: Readonly<Record<string, string>> = {
  [PROJECT]: 'Test Project',
  [FOLDER]: 'Test Folder',
  [DOC_A]: 'Launch brief',
  [DOC_B]: 'Budget notes',
  [DOC_ARCHIVED]: 'Old brief',
  [DOC_TEMPLATE]: 'Brief template',
  [THREAD]: 'Planning thread',
  [IMAGE]: 'Test diagram',
  [AGENT_A]: 'Test Agent A',
  [AGENT_B]: 'Test Agent B',
  [AGENT_ARCHIVED]: 'Test Agent C',
};

/** Drop every fixture item (children first) and every custom table. */
export async function cleanReferenceFixtures(): Promise<void> {
  const db = getDb();
  const { rows } = await db.query<{ table_name: string }>(
    "SELECT table_name FROM public.table_catalog WHERE origin = 'custom'"
  );
  for (const row of rows)
    await db.query(`DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`);
  await db.query(
    "DELETE FROM public.table_fields WHERE table_id IN (SELECT id FROM public.table_catalog WHERE origin = 'custom')"
  );
  await db.query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
  await db.query('DELETE FROM public.table_history');
  for (const id of NODES) await db.query('DELETE FROM public.nodes WHERE id = $1', [id]);
  await db.query('DELETE FROM public.agents WHERE id = ANY($1::text[])', [AGENTS]);
}

/** One live item of every kind, plus an archived doc and agent, a plain folder and a reply. */
export async function seedReferenceFixtures(): Promise<void> {
  const db = getDb();
  // A thread is scoped by project_id, never placed by container_id.
  const node = (id: string, type: string, parent: string | null = null, archived = false) =>
    db.query(
      `INSERT INTO public.nodes (id, type, container_id, project_id, archived, archived_at)
       VALUES ($1, $2::public.node_type,
               CASE WHEN $2 = 'thread' THEN NULL ELSE $3 END,
               CASE WHEN $2 = 'thread' THEN $3 ELSE NULL END,
               $4, CASE WHEN $4 THEN now() END)`,
      [id, type, parent, archived]
    );
  await node(PROJECT, 'container');
  await node(FOLDER, 'container');
  await db.query(
    `INSERT INTO public.containers (id, name, category) VALUES ($1, $2, 'project'), ($3, $4, NULL)`,
    [PROJECT, TITLES[PROJECT], FOLDER, TITLES[FOLDER]]
  );
  for (const [id, archived] of [
    [DOC_A, false],
    [DOC_B, false],
    [DOC_ARCHIVED, true],
    [DOC_TEMPLATE, false],
  ] as const) {
    await node(id, 'doc', PROJECT, archived);
    await db.query('INSERT INTO public.docs (id, title) VALUES ($1, $2)', [id, TITLES[id]]);
  }
  await node(THREAD, 'thread', PROJECT);
  await db.query('INSERT INTO public.threads (id, title) VALUES ($1, $2)', [
    THREAD,
    TITLES[THREAD],
  ]);
  await node(IMAGE, 'image', PROJECT);
  await db.query('INSERT INTO public.images (id, url, alt_text) VALUES ($1, $2, $3)', [
    IMAGE,
    'https://example.com/diagram.png',
    TITLES[IMAGE],
  ]);
  await db.query(
    `INSERT INTO public.agents (id, name, role, archived, archived_at)
     VALUES ($1, $2, 'Researcher', false, NULL), ($3, $4, 'Writer', false, NULL),
            ($5, $6, NULL, true, now())`,
    [AGENT_A, TITLES[AGENT_A], AGENT_B, TITLES[AGENT_B], AGENT_ARCHIVED, TITLES[AGENT_ARCHIVED]]
  );
}

/** Archive or restore a workspace node, as the archive routes do to its row. */
export async function setNodeArchived(id: string, archived: boolean): Promise<void> {
  await getDb().query(
    'UPDATE public.nodes SET archived = $2, archived_at = CASE WHEN $2 THEN now() END WHERE id = $1',
    [id, archived]
  );
}

/** Archive or restore an agent. */
export async function setAgentArchived(id: string, archived: boolean): Promise<void> {
  await getDb().query(
    'UPDATE public.agents SET archived = $2, archived_at = CASE WHEN $2 THEN now() END WHERE id = $1',
    [id, archived]
  );
}
