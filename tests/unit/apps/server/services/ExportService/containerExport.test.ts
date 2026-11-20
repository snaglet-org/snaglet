import path from 'path';
import os from 'os';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'fs/promises';
import { jest } from '@jest/globals';

const query = jest.fn();
jest.mock('@snaglet/db', () => ({ getDb: () => ({ query }) }));

import {
  MAX_CONTAINER_EXPORT_NODES,
  createUniqueDirectory,
  loadContainerExportRows,
  writeContainerExport,
  type ContainerExportIo,
  type ContainerExportTreeRow,
} from '@server/services/ExportService/containerExport';
import { writeExport } from '@server/services/ExportService/writeTarget';

const provenance = {
  exportedAt: '2026-08-05T12:00:00.000Z',
  exportedBy: 'Test User',
  snagletVersion: '0.1.0',
};

function row(
  id: string,
  kind: string,
  containerId: string | null,
  overrides: Partial<ContainerExportTreeRow> = {}
): ContainerExportTreeRow {
  return {
    id,
    kind,
    container_id: containerId,
    sort_order: 0,
    archived: false,
    archived_path: false,
    depth: containerId ? 1 : 0,
    container_name: kind === 'container' ? id : null,
    doc_title: kind === 'doc' ? id : null,
    doc_content: kind === 'doc' ? `Body for ${id}` : null,
    doc_created_at: kind === 'doc' ? '2026-01-01T00:00:00.000Z' : null,
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

let tempRoot: string;

beforeEach(async () => {
  jest.clearAllMocks();
  tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-container-export-')));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('bounded subtree read', () => {
  it('walks the nodes placement spine, never legacy type-table placement columns', async () => {
    const root = row('container-1', 'container', null, { container_name: 'Planning' });
    query.mockResolvedValue({ rows: [root] });

    await expect(loadContainerExportRows(root.id)).resolves.toEqual([root]);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('child.container_id = parent.id');
    expect(sql).toContain('n.updated_at');
    expect(sql).not.toMatch(
      /containers\.parent_id|containers\.sort_order|docs\.container_id|docs\.sort_order/
    );
    expect(params).toEqual([root.id, MAX_CONTAINER_EXPORT_NODES + 1]);
  });

  it('refuses an oversized subtree before any filesystem write', async () => {
    query.mockResolvedValue({
      rows: Array.from({ length: 4 }, (_, index) =>
        row(
          index === 0 ? 'container-1' : `doc-${index}`,
          index === 0 ? 'container' : 'doc',
          index === 0 ? null : 'container-1'
        )
      ),
    });

    await expect(loadContainerExportRows('container-1', 3)).rejects.toThrow(/3-node export limit/i);
  });

  it('does not export an archived or missing root', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(loadContainerExportRows('missing')).rejects.toThrow(/not found/i);

    query.mockResolvedValueOnce({
      rows: [row('container-1', 'container', null, { archived: true, archived_path: true })],
    });
    await expect(loadContainerExportRows('container-1')).rejects.toThrow(/archived/i);
  });
});

describe('recursive materialization', () => {
  it('creates nested folders, deterministic duplicate names, frontmatter, and a manifest', async () => {
    const rows = [
      row('root', 'container', null, { container_name: 'Release/Notes' }),
      row('doc-a', 'doc', 'root', { doc_title: 'Notes', sort_order: 1 }),
      row('doc-b', 'doc', 'root', { doc_title: 'Notes', sort_order: 2 }),
      row('child-a', 'container', 'root', { container_name: 'Section', sort_order: 3 }),
      row('child-b', 'container', 'root', { container_name: 'Section', sort_order: 4 }),
      row('nested', 'doc', 'child-a', {
        doc_title: 'Nested',
        container_id: 'child-a',
        depth: 2,
      }),
    ];

    const result = await writeContainerExport(rows, tempRoot, provenance);

    expect(result.directoryName).toBe('Release Notes');
    expect(await readdir(result.path)).toEqual(
      expect.arrayContaining([
        'Notes (2).md',
        'Notes.md',
        'Section',
        'Section (2)',
        'export-manifest.json',
      ])
    );
    await expect(readFile(path.join(result.path, 'Section', 'Nested.md'), 'utf8')).resolves.toMatch(
      /snaglet_kind: "doc"/
    );
    const manifest = JSON.parse(await readFile(result.manifestPath!, 'utf8')) as {
      summary: { containers: number; docs: number; skipped: number; failed: number };
    };
    expect(manifest.summary).toEqual({ containers: 3, docs: 3, skipped: 0, failed: 0 });
  });

  it('dedupes the root folder against any existing file, folder, or symlink name', async () => {
    await mkdir(path.join(tempRoot, 'Planning'));
    const rows = [row('root', 'container', null, { container_name: 'Planning' })];

    const result = await writeContainerExport(rows, tempRoot, provenance);

    expect(result.directoryName).toBe('Planning (2)');
    expect(path.basename(result.path)).toBe('Planning (2)');
  });

  it('exports an empty container honestly and skips archived and unsupported descendants', async () => {
    const empty = await writeContainerExport(
      [row('empty', 'container', null, { container_name: 'Empty' })],
      tempRoot,
      provenance
    );
    expect(empty.report.summary).toEqual({ containers: 1, docs: 0, skipped: 0, failed: 0 });

    const rows = [
      row('root', 'container', null, { container_name: 'Mixed' }),
      row('archived-folder', 'container', 'root', {
        container_name: 'Old',
        archived: true,
        archived_path: true,
      }),
      row('archived-doc', 'doc', 'archived-folder', {
        container_id: 'archived-folder',
        depth: 2,
        archived: true,
        archived_path: true,
      }),
      row('thread-1', 'thread', 'root'),
      row('image-1', 'image', 'root'),
    ];
    const mixed = await writeContainerExport(rows, tempRoot, provenance);

    expect(mixed.report.summary).toEqual({ containers: 1, docs: 0, skipped: 4, failed: 0 });
    expect(mixed.report.skipped.map((entry) => entry.kind).sort()).toEqual([
      'container',
      'doc',
      'image',
      'thread',
    ]);
    expect(await readdir(mixed.path)).toEqual(['export-manifest.json']);
  });

  it('keeps successful files and records a per-node failure instead of discarding the export', async () => {
    const rows = [
      row('root', 'container', null, { container_name: 'Partial' }),
      row('good', 'doc', 'root', { doc_title: 'Good' }),
      row('broken', 'doc', 'root', { doc_title: 'Broken', sort_order: 1 }),
    ];
    const io: ContainerExportIo = {
      createDirectory: createUniqueDirectory,
      async writeFile(dir, fileName, data) {
        if (fileName === 'Broken.md') throw new Error('disk full');
        return writeExport(dir, fileName, data, false);
      },
    };

    const result = await writeContainerExport(rows, tempRoot, provenance, io);

    await expect(readFile(path.join(result.path, 'Good.md'), 'utf8')).resolves.toContain(
      'Body for good'
    );
    expect(result.report.summary).toEqual({ containers: 1, docs: 1, skipped: 0, failed: 1 });
    expect(result.report.failed[0]).toMatchObject({ id: 'broken', reason: 'disk full' });
    await expect(readFile(result.manifestPath!, 'utf8')).resolves.toContain('disk full');
  });
});
