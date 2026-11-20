import { useEffect, useId, useRef, type FC, type ReactNode } from 'react';
import { formatRelativeTime } from '@snaglet/shared/utils';
import { ChatBubbleIcon, DocIcon, PlusIcon } from '@desktop/components/Icons';
import { DmAvatar } from '@desktop/features/dms';
import { cn } from '@desktop/utils/classNames';
import { SectionLabel, SectionState } from './HubSection';
import { PinIcon } from './hubIcons';
import type { HubDocRow, HubSelection, HubThreadRow, LoadStatus } from './hubTypes';
import styles from './HubView.module.scss';

interface ListRow {
  id: string;
  title: string;
  pinned: boolean;
  selection: HubSelection;
}

interface RecentListProps<Row extends ListRow> {
  title: string;
  status: LoadStatus;
  error: string | null;
  onRetry?: () => void;
  rows: Row[];
  onOpen: (selection: HubSelection) => void;
  onTogglePin: (row: Row) => void;
  /** Tint class for the row glyphs (the workspace tree's kind colors). */
  kindClass: string;
  glyph: (row: Row) => ReactNode;
  context: (row: Row) => ReactNode;
  /** The row's time, right-aligned; `title` is its hover text. */
  time: (row: Row) => { iso: string; title?: string } | null;
  /** Hover title for the whole row (names that do not fit one line). */
  rowTitle?: (row: Row) => string | undefined;
  emptyText: string;
  /** The create action ("New thread"), in the label row and the empty state. */
  createLabel?: string;
  onCreate?: () => void;
  creating?: boolean;
  actionError?: string | null;
  /** Called once per row the first time it scrolls into view. */
  onRowVisible?: (id: string) => void;
}

/**
 * One of Home's recent lists: a quiet label row and single-line rows (glyph,
 * title, muted context, time on the right, a pin on hover) in a scroll area
 * that fills the column's height. The scroll area is focusable and named, so
 * it scrolls from the keyboard.
 */
function RecentList<Row extends ListRow>({
  title,
  status,
  error,
  onRetry,
  rows,
  onOpen,
  onTogglePin,
  kindClass,
  glyph,
  context,
  time,
  rowTitle,
  emptyText,
  createLabel,
  onCreate,
  creating = false,
  actionError,
  onRowVisible,
}: RecentListProps<Row>) {
  const labelId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(onRowVisible);
  visibleRef.current = onRowVisible;

  // Report rows as they scroll into view, so per-row details (a thread's
  // agents and last message) load only for what is on screen.
  const rowKey = rows.map((row) => row.id).join('\u0000');
  useEffect(() => {
    const report = visibleRef.current;
    const root = scrollRef.current;
    if (!report || !root || !rowKey) return;
    if (typeof IntersectionObserver === 'undefined') {
      for (const id of rowKey.split('\u0000')) report(id);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.rowId;
          if (entry.isIntersecting && id) visibleRef.current?.(id);
        }
      },
      { root, rootMargin: '0px 0px 160px 0px' }
    );
    root.querySelectorAll('[data-row-id]').forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [rowKey]);

  const createButton =
    onCreate && createLabel && status === 'ready' && rows.length > 0 ? (
      <button
        type="button"
        className={styles.iconButton}
        onClick={onCreate}
        disabled={creating}
        aria-label={createLabel}
        title={createLabel}
      >
        <PlusIcon />
      </button>
    ) : undefined;

  return (
    <section className={cn(styles.list, kindClass)} aria-labelledby={labelId}>
      <SectionLabel
        id={labelId}
        count={status === 'ready' ? rows.length : undefined}
        actions={createButton}
      >
        {title}
      </SectionLabel>
      {actionError && (
        <p className={styles.inlineError} role="alert">
          {actionError}
        </p>
      )}
      <div
        ref={scrollRef}
        className={styles.listScroll}
        tabIndex={0}
        role="group"
        aria-label={`${title}, scrollable`}
      >
        <SectionState status={status} error={error} loadingText="Loading…" onRetry={onRetry} />
        {status === 'ready' && rows.length === 0 && (
          <p className={styles.stateLine}>
            {emptyText}
            {onCreate && createLabel && (
              <>
                {' '}
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={onCreate}
                  disabled={creating}
                >
                  {createLabel}
                </button>
              </>
            )}
          </p>
        )}
        {status === 'ready' && rows.length > 0 && (
          <ul className={styles.rows}>
            {rows.map((row) => {
              const at = time(row);
              return (
                <li
                  key={row.id}
                  className={styles.row}
                  data-row-id={row.id}
                  title={rowTitle?.(row)}
                >
                  <button
                    type="button"
                    className={styles.rowOpen}
                    onClick={() => onOpen(row.selection)}
                  >
                    <span className={styles.rowGlyph} aria-hidden>
                      {glyph(row)}
                    </span>
                    <span className={styles.rowTitle}>{row.title}</span>
                    <span className={styles.rowContext}>{context(row)}</span>
                    {at && (
                      <time className={styles.rowTime} dateTime={at.iso} title={at.title}>
                        {formatRelativeTime(at.iso)}
                      </time>
                    )}
                  </button>
                  <button
                    type="button"
                    className={cn(styles.pinToggle, row.pinned && styles.pinToggleOn)}
                    aria-pressed={row.pinned}
                    aria-label={row.pinned ? `Unpin ${row.title}` : `Pin ${row.title}`}
                    title={row.pinned ? 'Unpin from Home' : 'Pin to Home'}
                    onClick={() => onTogglePin(row)}
                  >
                    <PinIcon filled={row.pinned} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

interface SectionCommon<Row> {
  status: LoadStatus;
  error: string | null;
  onRetry?: () => void;
  rows: Row[];
  onOpen: (selection: HubSelection) => void;
  onTogglePin: (row: Row) => void;
}

export interface RecentThreadsSectionProps extends SectionCommon<HubThreadRow> {
  onNewThread: () => void;
  /** A failed or partial "New thread". */
  actionError?: string | null;
  /** A thread row scrolled into view (its agents and last message load then). */
  onRowVisible?: (id: string) => void;
}

const ThreadGlyph: FC<{ row: HubThreadRow }> = ({ row }) => {
  const [first] = row.agents;
  if (!first) return <ChatBubbleIcon />;
  return (
    <DmAvatar
      party={{
        kind: 'agent',
        agentId: first.id,
        cursorSpec: first.cursorSpec,
        avatarUrl: first.avatarUrl,
      }}
      size={18}
    />
  );
};

function threadContext(row: HubThreadRow): ReactNode {
  if (row.snippet) {
    return (
      <>
        {row.snippet.sender && <span className={styles.rowSender}>{row.snippet.sender}: </span>}
        {row.snippet.text}
      </>
    );
  }
  if (row.detailsStatus === 'loading') return null;
  return row.detailsStatus === 'error' ? 'Couldn’t read' : 'No messages yet';
}

function threadTitle(row: HubThreadRow): string | undefined {
  const parts = [
    row.title,
    row.projectName ? `in ${row.projectName}` : null,
    row.agents.length > 0 ? `with ${row.agents.map((agent) => agent.name).join(', ')}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export const RecentThreadsSection: FC<RecentThreadsSectionProps> = ({
  onNewThread,
  actionError,
  onRowVisible,
  ...common
}) => (
  <RecentList
    {...common}
    title="Recent threads"
    kindClass={styles.kindThread}
    glyph={(row) => <ThreadGlyph row={row} />}
    context={threadContext}
    time={(row) => (row.activityAt ? { iso: row.activityAt } : null)}
    rowTitle={threadTitle}
    emptyText="No threads yet."
    createLabel="New thread"
    onCreate={onNewThread}
    actionError={actionError}
    onRowVisible={onRowVisible}
  />
);

export interface RecentDocsSectionProps extends SectionCommon<HubDocRow> {
  onNewDoc: () => void;
  /** True while "New doc" is creating the doc. */
  creating?: boolean;
  actionError?: string | null;
}

export const RecentDocsSection: FC<RecentDocsSectionProps> = ({
  onNewDoc,
  creating,
  actionError,
  ...common
}) => (
  <RecentList
    {...common}
    title="Recently edited docs"
    kindClass={styles.kindDoc}
    glyph={() => <DocIcon />}
    context={(row) => (row.path.length > 0 ? row.path.join(' / ') : 'Workspace')}
    time={(row) => ({ iso: row.updatedAt, title: 'Last edited' })}
    emptyText="No docs yet."
    createLabel="New doc"
    onCreate={onNewDoc}
    creating={creating}
    actionError={actionError}
  />
);
