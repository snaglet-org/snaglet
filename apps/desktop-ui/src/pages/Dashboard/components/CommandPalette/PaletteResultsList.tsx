import { Fragment, type MouseEvent, type RefObject } from 'react';
import { formatBytes } from '@snaglet/shared/utils';
import { DocIcon, FolderIcon, PaperclipIcon } from '@desktop/components/Icons';
import type { PaletteFileNodeItem, PaletteFilesystemItem } from '@desktop/utils/api';
import { KindIcon } from './KindIcon';
import { formatResultMeta, resultTitle } from './paletteDisplay';
import { type SearchResult, type SearchSection } from './paletteResultMappers';
import styles from './CommandPalette.module.scss';

/** A pointer move over the row at `index`; the palette decides if it highlights it. */
type RowPointerMove = (index: number, event: MouseEvent) => void;

interface PaletteResultsListProps {
  listRef: RefObject<HTMLUListElement | null>;
  loading: boolean;
  lexicalLoading: boolean;
  serverLoading: boolean;
  total: number;
  term: string;
  /** Why the last picked result did not open, shown above the results. */
  openError: string | null;
  semanticEmpty: { message: string } | null;
  sections: SearchSection[];
  resultIndexById: Map<string, number>;
  resultsLength: number;
  fileResults: PaletteFileNodeItem[];
  filesystemResults: PaletteFilesystemItem[];
  activeIdx: number;
  onRowPointerMove: RowPointerMove;
  /** `secondary`: a ⌘/Ctrl-click, which opens a table row in its table instead. */
  pickResult: (hit: SearchResult, secondary?: boolean) => void;
  pickByIndex: (idx: number) => void;
}

/**
 * A row opens on a primary-button press only; a right or middle click leaves
 * it. ⌘ (Ctrl elsewhere) held makes it a secondary open.
 */
function onPrimaryPress(open: (secondary: boolean) => void) {
  return (e: MouseEvent) => {
    if (e.button === 0) open(e.metaKey || e.ctrlKey);
  };
}

interface NodeResultRowProps {
  hit: SearchResult;
  index: number;
  active: boolean;
  onRowPointerMove: RowPointerMove;
  pickResult: (hit: SearchResult, secondary?: boolean) => void;
}

function NodeResultRow({ hit, index, active, onRowPointerMove, pickResult }: NodeResultRowProps) {
  const meta = formatResultMeta(hit);
  return (
    <li
      className={`${styles.resultRow} ${active ? styles.resultRowActive : ''}`}
      role="option"
      aria-selected={active}
      data-result-index={index}
      title={resultTitle(hit, meta)}
      onMouseMove={(e) => onRowPointerMove(index, e)}
      onMouseDown={onPrimaryPress((secondary) => void pickResult(hit, secondary))}
    >
      <span className={`${styles.kindIcon} ${styles[`kind-${hit.node.kind}`] ?? ''}`}>
        <KindIcon kind={hit.node.kind} />
      </span>
      <span className={styles.resultBody}>
        <span className={styles.resultLabel}>{hit.label}</span>
        {meta && (
          <span className={styles.resultMeta} data-testid="result-meta">
            {meta}
          </span>
        )}
      </span>
      <span className={styles.resultBadges}>
        <span className={styles.kindBadge}>{hit.kindLabel}</span>
      </span>
    </li>
  );
}

interface FileResultRowProps {
  file: PaletteFileNodeItem;
  index: number;
  active: boolean;
  onRowPointerMove: RowPointerMove;
  pickByIndex: (idx: number) => void;
}

function FileResultRow({ file, index, active, onRowPointerMove, pickByIndex }: FileResultRowProps) {
  return (
    <li
      className={`${styles.resultRow} ${active ? styles.resultRowActive : ''}`}
      role="option"
      aria-selected={active}
      data-result-index={index}
      onMouseMove={(e) => onRowPointerMove(index, e)}
      onMouseDown={onPrimaryPress(() => pickByIndex(index))}
    >
      <span className={styles.kindIcon} aria-hidden>
        <PaperclipIcon />
      </span>
      <span className={styles.resultBody}>
        <span className={styles.resultLabel}>{file.relativePath}</span>
        <span className={styles.resultMeta} data-testid="result-meta">
          {formatBytes(file.sizeBytes)}
        </span>
      </span>
      <span className={styles.resultBadges}>
        <span className={styles.kindBadge}>File</span>
      </span>
    </li>
  );
}

/**
 * Result list surface for {@link CommandPalette}: node sections, indexed file
 * rows, and filesystem rows, plus the empty/loading status rows. Rendering is
 * kept faithful to the palette's unified nav-index scheme — node rows keep
 * their `resultIndexById` positions, file rows are appended after
 * `resultsLength`, and filesystem rows after that.
 */
export function PaletteResultsList({
  listRef,
  loading,
  lexicalLoading,
  serverLoading,
  total,
  term,
  openError,
  semanticEmpty,
  sections,
  resultIndexById,
  resultsLength,
  fileResults,
  filesystemResults,
  activeIdx,
  onRowPointerMove,
  pickResult,
  pickByIndex,
}: PaletteResultsListProps) {
  return (
    <ul
      ref={listRef}
      className={styles.results}
      role="listbox"
      aria-label="Search results"
      aria-busy={loading}
    >
      {openError && (
        <li className={styles.statusRow} role="option" aria-selected={false}>
          {openError}
        </li>
      )}
      {lexicalLoading && total === 0 && (
        <li className={styles.statusRow} role="option" aria-selected={false}>
          Loading workspace…
        </li>
      )}
      {!loading && total === 0 && (
        <li className={styles.statusRow} role="option" aria-selected={false}>
          {semanticEmpty ? semanticEmpty.message : 'No results'}
          {!semanticEmpty && term.trim() ? (
            <>
              {' '}
              for <strong>{term}</strong>
            </>
          ) : null}
        </li>
      )}
      {sections.map((section) => (
        <Fragment key={section.id}>
          <li className={styles.sectionHeader} role="presentation">
            <span>{section.label}</span>
            {/* Which search tier found the section: a development aid. */}
            {import.meta.env.DEV && section.origin === 'lexical' && (
              <span className={styles.sectionMeta}>instant</span>
            )}
          </li>
          {section.results.map((hit) => {
            const i = resultIndexById.get(hit.node.id) ?? 0;
            return (
              <NodeResultRow
                key={`${section.id}-${hit.node.id}`}
                hit={hit}
                index={i}
                active={i === activeIdx}
                onRowPointerMove={onRowPointerMove}
                pickResult={pickResult}
              />
            );
          })}
        </Fragment>
      ))}
      {fileResults.length > 0 && (
        <Fragment key="files">
          <li className={styles.sectionHeader} role="presentation">
            <span>Files</span>
            <span className={styles.sectionMeta}>indexed</span>
          </li>
          {fileResults.map((file, i) => {
            const idx = resultsLength + i;
            return (
              <FileResultRow
                key={`file-${file.nodeId}`}
                file={file}
                index={idx}
                active={idx === activeIdx}
                onRowPointerMove={onRowPointerMove}
                pickByIndex={pickByIndex}
              />
            );
          })}
        </Fragment>
      )}
      {filesystemResults.length > 0 && (
        <Fragment key="filesystem">
          <li className={styles.sectionHeader} role="presentation">
            <span>Filesystem</span>
          </li>
          {filesystemResults.map((item, i) => {
            const idx = resultsLength + fileResults.length + i;
            return (
              <li
                key={`fs-${item.path}`}
                className={`${styles.resultRow} ${idx === activeIdx ? styles.resultRowActive : ''}`}
                role="option"
                aria-selected={idx === activeIdx}
                data-result-index={idx}
                onMouseMove={(e) => onRowPointerMove(idx, e)}
                onMouseDown={onPrimaryPress(() => pickByIndex(idx))}
              >
                <span className={styles.kindIcon} aria-hidden>
                  {item.filesystemKind === 'folder' ? <FolderIcon /> : <DocIcon />}
                </span>
                <span className={styles.resultBody}>
                  <span className={styles.resultLabel}>{item.name}</span>
                  <span className={styles.resultMeta}>{item.path}</span>
                </span>
                <span className={styles.kindBadge}>
                  {item.filesystemKind === 'folder' ? 'Folder' : 'File'}
                </span>
              </li>
            );
          })}
        </Fragment>
      )}
      {serverLoading && (
        <li className={styles.serverLoadingRow} role="presentation">
          <span className={styles.serverLoadingShimmer} aria-hidden />
          Searching indexed workspace…
        </li>
      )}
    </ul>
  );
}
