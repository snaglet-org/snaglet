/**
 * Recursive container export built on the single-node export primitives.
 *
 * The database read is one bounded recursive query over the authoritative
 * nodes.container_id spine. Filesystem writes reuse the same destination
 * guard, filename sanitizer, and atomic no-clobber file writer as single-node
 * exports. A fresh, uniquely named root directory contains the whole run, so
 * partial failures can never overwrite a prior export.
 */

import path from 'path';
import { mkdir } from 'fs/promises';
import { getDb } from '@snaglet/db';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { resolveExportDir, resolveExportTarget } from './exportPaths';
import { safeFilename } from './safeFilename';
import { docFilename, serializeDoc, type ExportProvenance } from './serializers';
import { writeExport } from './writeTarget';

/** Bound export writes independently of the destructive-work budget for cloning. */
export const MAX_CONTAINER_EXPORT_NODES = 2_000;

export interface ContainerExportTreeRow {
  id: string;
  kind: string;
  container_id: string | null;
  sort_order: number;
  archived: boolean;
  archived_path: boolean;
  depth: number;
  container_name: string | null;
  doc_title: string | null;
  doc_content: string | null;
  doc_created_at: string | null;
  updated_at: string;
}

interface ContainerExportEntry {
  kind: string;
  id: string;
  name: string;
  path?: string;
  reason?: string;
  bytes?: number;
}

export interface ContainerExportReport {
  schemaVersion: 1;
  /** The loader omits these nodes entirely; skipped is not an inventory of them. */
  scope: string;
  container: { id: string; name: string };
  exportedAt: string;
  exportedBy: string;
  snagletVersion: string;
  exported: ContainerExportEntry[];
  skipped: ContainerExportEntry[];
  failed: ContainerExportEntry[];
  summary: {
    containers: number;
    docs: number;
    skipped: number;
    failed: number;
  };
}

export interface ContainerExportOutcome {
  directoryName: string;
  path: string;
  manifestPath?: string;
  bytes: number;
  report: ContainerExportReport;
}

export interface ContainerExportIo {
  createDirectory(
    parentDir: string,
    requestedName: string
  ): Promise<{ path: string; name: string }>;
  writeFile(
    resolvedDir: string,
    fileName: string,
    data: Buffer | string
  ): Promise<{ path: string; fileName: string }>;
}

const defaultIo: ContainerExportIo = {
  createDirectory: createUniqueDirectory,
  async writeFile(resolvedDir, fileName, data) {
    return writeExport(resolvedDir, fileName, data, false);
  },
};

function fail(message: string, status: number = HTTP_STATUS.BAD_REQUEST): never {
  throw new AppError(
    message,
    status >= HTTP_STATUS.INTERNAL_SERVER_ERROR
      ? ErrorCode.INTERNAL_ERROR
      : ErrorCode.VALIDATION_ERROR,
    status
  );
}

function displayName(row: ContainerExportTreeRow): string {
  if (row.kind === 'container') return row.container_name?.trim() || 'Untitled container';
  if (row.kind === 'doc') return row.doc_title?.trim() || 'Untitled doc';
  return row.id;
}

function portableRelative(rootDir: string, target: string): string {
  const relative = path.relative(rootDir, target);
  return relative ? relative.split(path.sep).join('/') : '.';
}

function compareRows(a: ContainerExportTreeRow, b: ContainerExportTreeRow): number {
  return (
    a.sort_order - b.sort_order ||
    displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' }) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Allocate a directory without checking then writing. mkdir is the arbiter:
 * any existing file, folder, or symlink advances to the next deterministic
 * suffix instead of being followed or overwritten.
 */
export async function createUniqueDirectory(
  parentDir: string,
  requestedName: string
): Promise<{ path: string; name: string }> {
  const base = safeFilename(requestedName, 'untitled-container');
  for (let n = 1; n < 10_000; n += 1) {
    const name = n === 1 ? base : `${base} (${n})`;
    const target = resolveExportTarget(parentDir, name);
    try {
      await mkdir(target);
      return { path: target, name };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  fail(`Could not find a free folder name for "${base}" after 10000 attempts`);
}

/**
 * One snapshot-consistent, cycle-safe read capped on exportable work, including
 * the root. Unsupported kinds and archived subtrees are pruned before LIMIT:
 * indexed files must neither exhaust the budget nor inflate the manifest.
 */
export async function loadContainerExportRows(
  rootId: string,
  maxNodes = MAX_CONTAINER_EXPORT_NODES
): Promise<ContainerExportTreeRow[]> {
  const { rows } = await getDb().query<ContainerExportTreeRow>(
    `WITH RECURSIVE subtree AS (
       SELECT n.id,
              n.type::text AS kind,
              n.container_id,
              n.sort_order,
              n.archived,
              n.archived AS archived_path,
              0 AS depth,
              ARRAY[n.id]::text[] AS path_ids
         FROM public.nodes n
        WHERE n.id = $1
          AND n.type = 'container'

       UNION ALL

       SELECT child.id,
              child.type::text AS kind,
              child.container_id,
              child.sort_order,
              child.archived,
              parent.archived_path OR child.archived AS archived_path,
              parent.depth + 1 AS depth,
              parent.path_ids || child.id
         FROM public.nodes child
         JOIN subtree parent ON child.container_id = parent.id
        WHERE parent.kind = 'container'
          AND NOT parent.archived_path
          AND child.type IN ('container', 'doc')
          AND NOT child.archived
          AND NOT child.id = ANY(parent.path_ids)
     )
     SELECT s.id,
            s.kind,
            s.container_id,
            s.sort_order,
            s.archived,
            s.archived_path,
            s.depth,
            c.name AS container_name,
            d.title AS doc_title,
            d.content AS doc_content,
            d.created_at::text AS doc_created_at,
            n.updated_at::text AS updated_at
       FROM subtree s
       JOIN public.nodes n ON n.id = s.id
       LEFT JOIN public.containers c ON c.id = s.id AND s.kind = 'container'
       LEFT JOIN public.docs d ON d.id = s.id AND s.kind = 'doc'
      LIMIT $2`,
    [rootId, maxNodes + 1]
  );

  const root = rows.find((row) => row.id === rootId && row.kind === 'container');
  if (!root) {
    throw new AppError(
      `Container not found: ${rootId}`,
      ErrorCode.NOT_FOUND,
      HTTP_STATUS.NOT_FOUND
    );
  }
  if (root.archived) {
    throw new AppError(
      `Container is archived: ${rootId}`,
      ErrorCode.NOT_FOUND,
      HTTP_STATUS.NOT_FOUND
    );
  }
  if (!root.container_name) {
    fail(`Container data is missing for ${rootId}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
  if (rows.length > maxNodes) {
    fail(
      `Cannot export: subtree exceeds the ${maxNodes}-node export limit ` +
        '(non-archived containers and docs, including the root). Export a smaller container.'
    );
  }
  return [root, ...rows.filter((row) => row !== root)];
}

/**
 * Materialize a preloaded subtree. Exportable siblings are processed in stable
 * workspace order; unsupported and archived nodes are recorded, never written.
 */
export async function writeContainerExport(
  rows: ContainerExportTreeRow[],
  destination: string,
  provenance: ExportProvenance,
  io: ContainerExportIo = defaultIo
): Promise<ContainerExportOutcome> {
  const root = rows[0];
  if (!root || root.kind !== 'container' || !root.container_name) {
    fail('Container export snapshot has no valid root.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }

  const resolvedDestination = await resolveExportDir(destination);
  const rootDirectory = await io.createDirectory(resolvedDestination, root.container_name);
  const children = new Map<string, ContainerExportTreeRow[]>();
  for (const row of rows.slice(1)) {
    if (!row.container_id) continue;
    const list = children.get(row.container_id) ?? [];
    list.push(row);
    children.set(row.container_id, list);
  }
  for (const list of children.values()) list.sort(compareRows);

  const exported: ContainerExportEntry[] = [
    { kind: 'container', id: root.id, name: root.container_name, path: '.' },
  ];
  const skipped: ContainerExportEntry[] = [];
  const failed: ContainerExportEntry[] = [];
  let bytes = 0;

  const recordSkippedSubtree = (row: ContainerExportTreeRow, reason: string): void => {
    skipped.push({ kind: row.kind, id: row.id, name: displayName(row), reason });
    if (row.kind === 'container') {
      for (const child of children.get(row.id) ?? []) recordSkippedSubtree(child, reason);
    }
  };

  const recordFailedSubtree = (row: ContainerExportTreeRow, reason: string): void => {
    if (row.archived_path) {
      recordSkippedSubtree(row, 'Archived nodes are not included in exports.');
      return;
    }
    if (row.kind === 'container' || row.kind === 'doc') {
      failed.push({ kind: row.kind, id: row.id, name: displayName(row), reason });
    } else {
      skipped.push({
        kind: row.kind,
        id: row.id,
        name: displayName(row),
        reason: `Unsupported node kind: ${row.kind}`,
      });
    }
    if (row.kind === 'container') {
      for (const child of children.get(row.id) ?? []) recordFailedSubtree(child, reason);
    }
  };

  const writeChildren = async (
    containerId: string,
    folderPath: string,
    relativeFolder: string
  ): Promise<void> => {
    for (const row of children.get(containerId) ?? []) {
      if (row.archived_path) {
        recordSkippedSubtree(row, 'Archived nodes are not included in exports.');
        continue;
      }

      if (row.kind === 'container') {
        try {
          const directory = await io.createDirectory(folderPath, displayName(row));
          const relative =
            relativeFolder === '.' ? directory.name : `${relativeFolder}/${directory.name}`;
          exported.push({
            kind: 'container',
            id: row.id,
            name: displayName(row),
            path: relative,
          });
          await writeChildren(row.id, directory.path, relative);
        } catch (error) {
          recordFailedSubtree(
            row,
            getErrorMessage(error, `Could not create folder for ${displayName(row)}`)
          );
        }
        continue;
      }

      if (row.kind !== 'doc') {
        skipped.push({
          kind: row.kind,
          id: row.id,
          name: displayName(row),
          reason: `Unsupported node kind: ${row.kind}`,
        });
        continue;
      }

      if (row.doc_title === null || row.doc_content === null || row.doc_created_at === null) {
        failed.push({
          kind: 'doc',
          id: row.id,
          name: displayName(row),
          reason: 'Doc data is missing.',
        });
        continue;
      }

      const data = Buffer.from(
        serializeDoc(
          {
            id: row.id,
            title: row.doc_title,
            content: row.doc_content,
            containerId: row.container_id,
            createdAt: row.doc_created_at,
            updatedAt: row.updated_at,
          },
          provenance
        ),
        'utf8'
      );
      try {
        const outcome = await io.writeFile(folderPath, docFilename({ title: row.doc_title }), data);
        bytes += data.byteLength;
        exported.push({
          kind: 'doc',
          id: row.id,
          name: row.doc_title,
          path: portableRelative(rootDirectory.path, outcome.path),
          bytes: data.byteLength,
        });
      } catch (error) {
        failed.push({
          kind: 'doc',
          id: row.id,
          name: row.doc_title,
          reason: getErrorMessage(error, `Could not export ${row.doc_title}`),
        });
      }
    }
  };

  await writeChildren(root.id, rootDirectory.path, '.');

  const report: ContainerExportReport = {
    schemaVersion: 1,
    scope:
      'Non-archived containers and docs only. Other node kinds and archived subtrees are ' +
      'excluded before loading and are not inventoried in skipped.',
    container: { id: root.id, name: root.container_name },
    exportedAt: provenance.exportedAt,
    exportedBy: provenance.exportedBy,
    snagletVersion: provenance.snagletVersion,
    exported,
    skipped,
    failed,
    summary: {
      containers: exported.filter((entry) => entry.kind === 'container').length,
      docs: exported.filter((entry) => entry.kind === 'doc').length,
      skipped: skipped.length,
      failed: failed.length,
    },
  };

  let manifestPath: string | undefined;
  const manifest = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  try {
    const outcome = await io.writeFile(rootDirectory.path, 'export-manifest.json', manifest);
    manifestPath = outcome.path;
    bytes += manifest.byteLength;
  } catch (error) {
    failed.push({
      kind: 'manifest',
      id: root.id,
      name: 'export-manifest.json',
      reason: getErrorMessage(error, 'Could not write the export manifest.'),
    });
    report.summary.failed = failed.length;
  }

  return {
    directoryName: rootDirectory.name,
    path: rootDirectory.path,
    manifestPath,
    bytes,
    report,
  };
}

export async function exportContainer(
  rootId: string,
  destination: string,
  provenance: ExportProvenance
): Promise<ContainerExportOutcome> {
  const rows = await loadContainerExportRows(rootId);
  return writeContainerExport(rows, destination, provenance);
}
