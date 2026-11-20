import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { Containers, Docs, getDb } from '@snaglet/db';
import {
  exportContainer,
  loadContainerExportRows,
  MAX_CONTAINER_EXPORT_NODES,
} from '@server/services/ExportService/containerExport';

/**
 * The first test proves what does not count toward the export cap (file nodes,
 * archived branches) against a small injected cap, so its fixture stays a few
 * dozen rows instead of thousands; the real 2000 boundary has its own test.
 */
const SMALL_CAP = 20;

const provenance = {
  exportedAt: '2026-09-18T12:00:00.000Z',
  exportedBy: 'Test User',
  snagletVersion: '0.1.0',
};

// Jest's integration harness owns a disposable per-file database. Never use a
// user's workspace to exercise the recursive query or the filesystem writer.
describe('container export with real PostgreSQL', () => {
  let destination: string;

  beforeEach(async () => {
    destination = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'snaglet-export-integration-'))
    );
  });

  afterEach(async () => {
    await rm(destination, { recursive: true, force: true });
  });

  it('exports nested docs despite more file nodes and archived docs than the cap', async () => {
    const root = 'export-test-mixed';
    const nested = `${root}-nested`;
    const archived = `${root}-archived`;
    await Containers.create({ id: root, name: 'Project' });
    await Containers.create({ id: nested, name: 'Notes', parentId: root });
    await Containers.create({ id: archived, name: 'Old notes', parentId: root });
    await Docs.create({
      id: `${root}-doc`,
      title: 'Overview',
      content: 'Root body',
      containerId: root,
    });
    await Docs.create({
      id: `${nested}-doc`,
      title: 'Nested',
      content: 'Nested body',
      containerId: nested,
    });
    await getDb().query(
      `INSERT INTO public.nodes (id, type, container_id)
       SELECT $1 || '-file-' || n, 'file', $1 FROM generate_series(1, $2::integer) n`,
      [root, SMALL_CAP * 3]
    );
    await getDb().query(
      'UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1',
      [archived]
    );
    // Deliberately active descendants below an archived parent must also be
    // pruned. Insert more of them than the cap allows.
    await getDb().query(
      `WITH inserted AS (
         INSERT INTO public.nodes (id, type, container_id)
         SELECT $1 || '-doc-' || n, 'doc', $1 FROM generate_series(1, $2::integer) n
         RETURNING id
       ) INSERT INTO public.docs (id, title, content)
         SELECT id, 'Archived branch', 'Must not be exported' FROM inserted`,
      [archived, SMALL_CAP * 2]
    );
    await Docs.create({
      id: `${root}-old-doc`,
      title: 'Old doc',
      content: 'Hidden',
      containerId: root,
    });
    await getDb().query(
      'UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1',
      [`${root}-old-doc`]
    );

    const expected = [root, nested, `${root}-doc`, `${nested}-doc`].sort();
    const capped = await loadContainerExportRows(root, SMALL_CAP);
    expect(capped.map(({ id }) => id).sort()).toEqual(expected);
    const rows = await loadContainerExportRows(root);
    expect(rows.map(({ id }) => id).sort()).toEqual(expected);
    const first = await exportContainer(root, destination, provenance);
    expect(first.report.summary).toEqual({ containers: 2, docs: 2, skipped: 0, failed: 0 });
    // readdir order is filesystem-defined; compare as a set.
    expect((await readdir(first.path)).sort()).toEqual([
      'Notes',
      'Overview.md',
      'export-manifest.json',
    ]);
    await expect(readFile(path.join(first.path, 'Notes', 'Nested.md'), 'utf8')).resolves.toContain(
      'Nested body'
    );
    const manifest = JSON.parse(await readFile(first.manifestPath!, 'utf8')) as { scope: string };
    expect(manifest.scope).toContain('not inventoried in skipped');

    const second = await exportContainer(root, destination, provenance);
    expect(second.directoryName).toBe('Project (2)');
    await expect(readFile(path.join(first.path, 'Overview.md'), 'utf8')).resolves.toContain(
      'Root body'
    );
  });

  it('allows exactly 2000 exportable nodes, then rejects one more before creating a folder', async () => {
    const root = 'export-test-limit';
    await Containers.create({ id: root, name: 'Too large' });
    await getDb().query(
      `WITH inserted AS (
         INSERT INTO public.nodes (id, type, container_id)
         SELECT $1 || '-doc-' || n, 'doc', $1 FROM generate_series(1, $2::integer) n
         RETURNING id
       ) INSERT INTO public.docs (id, title, content)
         SELECT id, id, 'Body' FROM inserted`,
      [root, MAX_CONTAINER_EXPORT_NODES - 1]
    );
    await expect(loadContainerExportRows(root)).resolves.toHaveLength(2000);
    await Docs.create({ id: `${root}-extra`, title: 'Extra', content: 'Body', containerId: root });

    await expect(exportContainer(root, destination, provenance)).rejects.toThrow(
      '2000-node export limit (non-archived containers and docs, including the root)'
    );
    expect(await readdir(destination)).toEqual([]);
  });

  it('continues rejecting archived and nonexistent roots', async () => {
    const root = 'export-test-archived-root';
    await Containers.create({ id: root, name: 'Archived' });
    await getDb().query(
      'UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1',
      [root]
    );
    await expect(exportContainer(root, destination, provenance)).rejects.toThrow(
      'Container is archived'
    );
    await expect(exportContainer('export-test-missing', destination, provenance)).rejects.toThrow(
      'Container not found'
    );
    expect(await readdir(destination)).toEqual([]);
  });
});
