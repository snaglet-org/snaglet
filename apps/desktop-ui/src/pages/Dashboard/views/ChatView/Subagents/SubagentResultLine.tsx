import { useMemo, useState, type FC } from 'react';
import type { ThreadMessage, ThreadMessageSubagentResult } from '@desktop/utils/api';
import { Button } from '@desktop/components';
import { MarkdownRenderer } from '@desktop/features/rich-markdown/renderer';
import type { RenderMode } from '../ChatView';
import { useSubagentNavigation } from './subagentNavigation';
import {
  helperThreadTitle,
  subagentOutcome,
  subagentReport,
  subagentResultLabel,
} from './subagentText';
import styles from './SubagentResultLine.module.scss';

interface SubagentResultLineProps {
  message: ThreadMessage;
  result: ThreadMessageSubagentResult;
  renderMode: RenderMode;
}

/**
 * A subagent helper's result row in the parent thread, as one quiet meta
 * line — "Patty's subagent Scout finished". The row is addressed to the
 * orchestrator; clicking the line shows the report it carries, plus Open
 * thread while the helper still exists.
 */
export const SubagentResultLine: FC<SubagentResultLineProps> = ({
  message,
  result,
  renderMode,
}) => {
  const [open, setOpen] = useState(false);
  const nav = useSubagentNavigation();
  const outcome = subagentOutcome(result, message.content);
  const { error, report } = useMemo(
    () => subagentReport(message.content, result.name),
    [message.content, result.name]
  );
  const threadId = result.threadId;
  const openHelperThread = nav?.openHelperThread ?? null;
  // Only while the helper still exists: once removed its thread is gone too.
  const openThread =
    openHelperThread && threadId && nav?.liveThreadIds.has(threadId)
      ? () => openHelperThread(threadId, helperThreadTitle(result.orchestratorName, result.name))
      : null;

  return (
    <div
      className={styles.root}
      data-message-id={message.id}
      data-tid="subagentResultRow"
      data-outcome={outcome}
    >
      <button
        type="button"
        className={styles.line}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.caret} aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span>{subagentResultLabel(result, message.content)}</span>
      </button>
      {open && (
        <div className={styles.details} data-tid="subagentReport">
          {error && <div className={styles.error}>{error}</div>}
          {report ? (
            renderMode === 'md' ? (
              <MarkdownRenderer
                content={report}
                className={styles.markdown}
                showIncludeToggle={false}
              />
            ) : (
              <div className={styles.raw}>{report}</div>
            )
          ) : (
            !error && <div className={styles.empty}>No report.</div>
          )}
          {openThread && (
            <div className={styles.actions}>
              <Button variant="link" size="xs" onClick={openThread}>
                Open thread
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
