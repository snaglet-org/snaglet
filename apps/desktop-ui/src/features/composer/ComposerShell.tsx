import type { FC, HTMLAttributes, ReactNode, Ref } from 'react';
import styles from './ComposerShell.module.scss';

export interface ComposerShellProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  ref?: Ref<HTMLDivElement>;
  /** The editor. Give the main one `composerInputClassName`. */
  children: ReactNode;
  /** Above the editor, divided from it (a post title, say). */
  header?: ReactNode;
  /** Thumbnail strip above the editor; renders only when set. */
  attachments?: ReactNode;
  attachmentsLabel?: string;
  /** Popovers anchored to the bubble. */
  overlay?: ReactNode;
  /** Status lines under the editor — `ComposerNotice`s. */
  notices?: ReactNode;
  /** Left of the action row (attach, hints). */
  leadingActions?: ReactNode;
  /** Right of the action row (Stop, Send, Cancel, Post). */
  trailingActions?: ReactNode;
  actionsTestId?: string;
  /** Highlight the bubble as a drop target. */
  dragOver?: boolean;
}

/**
 * ComposerShell — the rounded input bubble every composer shares:
 * header, attachment strip, editor, notices and a divided action row, with
 * one focus ring around the whole box. Purely presentational; hosts own
 * the text, submit rules, drafts and anything rendered outside the bubble.
 * Extra props (drag handlers, `data-*`, test ids) land on the bubble.
 */
export const ComposerShell: FC<ComposerShellProps> = ({
  ref,
  children,
  header,
  attachments,
  attachmentsLabel = 'Attachments',
  overlay,
  notices,
  leadingActions,
  trailingActions,
  actionsTestId,
  dragOver = false,
  className,
  ...bubbleProps
}) => (
  <div
    ref={ref}
    className={[styles.bubble, dragOver ? styles.dragOver : '', className ?? '']
      .filter(Boolean)
      .join(' ')}
    {...bubbleProps}
  >
    {overlay}
    {header && <div className={styles.header}>{header}</div>}
    {attachments && (
      <div className={styles.attachments} role="group" aria-label={attachmentsLabel}>
        {attachments}
      </div>
    )}
    {children}
    {notices}
    {(leadingActions || trailingActions) && (
      <div className={styles.actions} data-testid={actionsTestId}>
        {leadingActions && <div className={styles.leading}>{leadingActions}</div>}
        {trailingActions}
      </div>
    )}
  </div>
);

type ComposerNoticeTone = 'info' | 'warning' | 'error';

export interface ComposerNoticeProps {
  tone?: ComposerNoticeTone;
  /** Defaults to `status` for info and `alert` otherwise. */
  role?: 'status' | 'alert';
  children: ReactNode;
  /** Buttons that resolve the notice, rendered after the text. */
  actions?: ReactNode;
}

/** One line of composer feedback under the editor. */
export const ComposerNotice: FC<ComposerNoticeProps> = ({
  tone = 'info',
  role,
  children,
  actions,
}) => (
  <div
    className={styles.notice}
    data-tone={tone}
    role={role ?? (tone === 'info' ? 'status' : 'alert')}
  >
    <div className={styles.noticeText}>{children}</div>
    {actions && <div className={styles.noticeActions}>{actions}</div>}
  </div>
);

/** Class for a host's main editor inside the shell (size, auto-grow cap). */
export const composerInputClassName: string = styles.input;
