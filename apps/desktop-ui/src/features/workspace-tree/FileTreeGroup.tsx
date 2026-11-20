import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { FileRecord, FileTreeNode } from '../../utils/api';
import {
  clearChipDragPayload,
  setChipDragPayload,
  nodeToChipMarkdown,
} from '@desktop/utils/nodeChip';
import { DocIcon, FolderIcon, LeafToggle } from '@desktop/components/Icons';
import { CopyToClipboardButton } from '@desktop/components';
import { TreeGroupHeader } from './TreeGroupHeader';
import { guideStyle, rowIndent } from './treeUtils';
import styles from './WorkspaceTree.module.scss';

// Renders a project's indexed files as a collapsible folder tree under the
// project-home row. Files are stored flat (each row's `relativePath` carries
// the on-disk hierarchy), so the folders are rebuilt here. Read-only: a file
// click opens it via `onNodeClick`. Folder expansion is local state that
// resets when the project row collapses.

interface DirNode {
  name: string;
  /** Project-relative path (carries the on-disk hierarchy). */
  path: string;
  /** Absolute on-disk path — what a dragged folder chip references. Derived
   * from a contained file's absolutePath (so it's correct for satellite
   * projects too, where relativePath is stripped but absolutePath isn't). */
  absPath: string;
  dirs: Map<string, DirNode>;
  files: FileRecord[];
}

/** Build a nested folder tree from flat relative paths, recording each folder's
 *  absolute path from a contained file. */
function buildDirTree(files: FileRecord[]): DirNode {
  const root: DirNode = { name: '', path: '', absPath: '', dirs: new Map(), files: [] };
  for (const rec of files) {
    const parts = rec.relativePath.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    // The file's absolute segments share a trailing run with its relative
    // segments; everything before that run is the project root. So the dir at
    // relative depth (i+1) maps to absSegs[0 .. rootDepth + i + 1].
    const absSegs = rec.absolutePath.split('/');
    const rootDepth = absSegs.length - parts.length;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i];
      const childPath = cur.path ? `${cur.path}/${seg}` : seg;
      let dir = cur.dirs.get(seg);
      if (!dir) {
        const absPath = rootDepth >= 0 ? absSegs.slice(0, rootDepth + i + 1).join('/') : childPath;
        dir = { name: seg, path: childPath, absPath, dirs: new Map(), files: [] };
        cur.dirs.set(seg, dir);
      }
      cur = dir;
    }
    cur.files.push(rec);
  }
  return root;
}

interface FileTreeGroupProps {
  /** `undefined` / `null` = still loading; an array = loaded (possibly empty). */
  files: FileRecord[] | null | undefined;
  projectId: string;
  /** Owning container of the project-home row, carried onto opened file nodes. */
  containerId: string | null;
  /** Indent depth of the project-home row; the group sits one level under it. */
  depth: number;
  onNodeClick?: (node: FileTreeNode) => void;
  /** Id of the file currently open in the active pane, for the `active` style. */
  activeNodeId?: string | null;
  /** Set of node ids open in any pane, for the "open in a pane" indicator. */
  openNodeIds?: Set<string>;
}

export function FileTreeGroup({
  files,
  projectId,
  containerId,
  depth,
  onNodeClick,
  activeNodeId,
  openNodeIds,
}: FileTreeGroupProps) {
  // Collapsed by default (matches the Tasks group), and folder open-state.
  const [groupOpen, setGroupOpen] = useState(false);
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());

  const tree = useMemo(() => buildDirTree(files ?? []), [files]);
  const loading = files === undefined || files === null;
  const count = loading ? null : files.length;

  const toggleDir = (path: string) =>
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const openFile = (rec: FileRecord) => {
    const name = rec.relativePath.split('/').pop() ?? rec.relativePath;
    onNodeClick?.({
      kind: 'file',
      id: rec.id,
      containerId,
      projectId,
      relativePath: rec.relativePath,
      name,
      sizeBytes: rec.sizeBytes,
      updatedAt: rec.updatedAt,
    });
  };

  // Recursively render a directory's contents: subfolders first (alpha), then
  // files (alpha). `rowDepth` is the indent level for this dir's children.
  const renderDir = (dir: DirNode, rowDepth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    const subdirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const sub of subdirs) {
      const open = openDirs.has(sub.path);
      out.push(
        <div
          key={`d:${sub.path}`}
          className={styles.rowGroup}
          role="treeitem"
          aria-expanded={open}
          aria-label={sub.name}
          aria-level={rowDepth + 1}
          data-inspect-id={sub.path}
        >
          <div
            className={styles.row}
            style={{ paddingLeft: rowIndent(rowDepth) }}
            role="button"
            tabIndex={0}
            onClick={(e: ReactMouseEvent<HTMLDivElement>) => {
              e.stopPropagation();
              toggleDir(sub.path);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleDir(sub.path);
              }
            }}
            draggable
            // Drag a folder into a composer/editor as a `folder:<abs-path>` chip.
            // It's an agent-facing path reference (parses to the absolute path),
            // not a previewable file, so clicking it does nothing.
            onDragStart={(e) =>
              setChipDragPayload(e, {
                chip: { id: sub.absPath, kind: 'folder', title: sub.name, name: sub.name },
                dragLabel: sub.absPath,
              })
            }
            onDragEnd={clearChipDragPayload}
          >
            <span className={styles.chevron} aria-hidden>
              <LeafToggle open={open} className={styles.leafToggle} />
            </span>
            <span className={styles.icon} aria-hidden>
              <FolderIcon />
            </span>
            <span className={styles.label} title={sub.path}>
              {sub.name}
            </span>
          </div>
        </div>
      );
      if (open) out.push(...renderDir(sub, rowDepth + 1));
    }
    const sortedFiles = [...dir.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    for (const rec of sortedFiles) {
      const name = rec.relativePath.split('/').pop() ?? rec.relativePath;
      const isActive = activeNodeId === rec.id;
      const isOpen = openNodeIds?.has(rec.id) ?? false;
      out.push(
        <div
          key={`f:${rec.id}`}
          className={styles.rowGroup}
          role="treeitem"
          aria-label={name}
          aria-level={rowDepth + 1}
          aria-selected={isActive}
          data-inspect-id={rec.id}
        >
          <div
            className={[
              styles.row,
              isActive ? styles.rowSelected : '',
              isOpen ? styles.rowOpen : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ paddingLeft: rowIndent(rowDepth) }}
            role="button"
            tabIndex={0}
            onClick={(e: ReactMouseEvent<HTMLDivElement>) => {
              e.stopPropagation();
              openFile(rec);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openFile(rec);
              }
            }}
            draggable
            // Drag a file row into a composer / doc editor as a chip link. The
            // chip's id is the absolute on-disk path, so chipHrefForNode emits a
            // `file:<abs-path>` href that parses back to `/abs/path` (not the
            // project-relative path, and not the file node id).
            onDragStart={(e) =>
              setChipDragPayload(e, {
                chip: { id: rec.absolutePath, kind: 'file', title: name, name },
                dragLabel: rec.absolutePath,
              })
            }
            onDragEnd={clearChipDragPayload}
          >
            <span className={[styles.chevron, styles.chevronEmpty].join(' ')} aria-hidden />
            <span className={styles.icon} aria-hidden>
              <DocIcon />
            </span>
            <span className={styles.label} title={rec.relativePath}>
              {name}
            </span>
            {/* File chips reference the absolute path (a `file:<abs>` href),
                matching the file drag-chip grammar — not a node id. Wrapped in
                the shared right-anchored `.rowActions` group (same as TreeRow)
                so the copy button stays pinned to the row's right edge; the
                group, not the button, owns `margin-left: auto`. */}
            <div className={styles.rowActions}>
              <CopyToClipboardButton
                value={nodeToChipMarkdown({
                  id: rec.absolutePath,
                  kind: 'file',
                  title: name,
                  name,
                })}
                className={styles.copyLinkBtn}
                stopPropagation
                idleTitle="Copy link"
                copiedTitle="Link copied!"
                aria-label={`Copy link to ${name}`}
              />
            </div>
          </div>
        </div>
      );
    }
    return out;
  };

  return (
    <div role="group" className={styles.indentGuide} style={guideStyle(depth)}>
      <TreeGroupHeader
        label="Files"
        count={count}
        open={groupOpen}
        onToggle={() => setGroupOpen((v) => !v)}
        depth={depth + 1}
      />
      {groupOpen &&
        (loading ? (
          <div className={styles.taskHint} style={{ paddingLeft: rowIndent(depth + 2) }}>
            Loading files…
          </div>
        ) : count === 0 ? (
          <div className={styles.taskHint} style={{ paddingLeft: rowIndent(depth + 2) }}>
            No indexed files
          </div>
        ) : (
          renderDir(tree, depth + 2)
        ))}
    </div>
  );
}
