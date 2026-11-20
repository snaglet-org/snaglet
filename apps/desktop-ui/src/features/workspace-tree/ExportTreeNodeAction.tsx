import { useEffect, type FC, type MouseEvent, type PointerEvent } from 'react';
import { useNodeExport } from '@desktop/hooks/useNodeExport';
import { showToast } from '@desktop/utils/toast';
import { ExportIcon } from '@desktop/components/Icons';
import styles from './WorkspaceTree.module.scss';

export interface ExportTreeNodeActionProps {
  kind: 'doc' | 'container';
  id: string;
  label: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Shared row-level export affordance for docs and containers.
 *
 * Every pointer/drag/context event terminates at the button. The surrounding
 * tree row is selectable, expandable, draggable, and context-menu enabled, so
 * allowing even one of those events to bubble would make Export do two things.
 */
export const ExportTreeNodeAction: FC<ExportTreeNodeActionProps> = ({ kind, id, label }) => {
  const { state, exportNode, reset } = useNodeExport();

  useEffect(() => reset(), [id, kind, reset]);

  useEffect(() => {
    if (state.status === 'written') {
      showToast(`Exported “${label}” to ${state.path}.`);
    } else if (state.status === 'downloaded') {
      showToast(`Downloaded ${state.fileName}.`);
    } else if (state.status === 'container-written') {
      const { docs, skipped, failed } = state.report.summary;
      const details = [
        skipped > 0 ? plural(skipped, 'skipped node') : null,
        failed > 0 ? plural(failed, 'failed node') : null,
      ].filter(Boolean);
      const report = state.manifestPath ? ` Report: ${state.manifestPath}.` : '';
      showToast(
        `Exported ${plural(docs, 'doc')} to ${state.path}.` +
          (details.length > 0 ? ` ${details.join(', ')}.` : '') +
          report,
        { durationMs: failed > 0 || skipped > 0 ? 6000 : 3000 }
      );
    } else if (state.status === 'error') {
      showToast(`Export failed: ${state.message}`, { durationMs: 6000 });
    }
  }, [label, state]);

  const stop = (event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  return (
    <span
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={styles.exportBtn}
        aria-label={`Export ${label}`}
        title={kind === 'container' ? 'Export this container as a folder' : 'Export this doc'}
        draggable={false}
        disabled={state.status === 'working'}
        onPointerDown={stop}
        onMouseDown={stop}
        onDoubleClick={stop}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onDragStart={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          void exportNode({ kind, id, suggestedName: label });
        }}
      >
        <ExportIcon />
      </button>
    </span>
  );
};
