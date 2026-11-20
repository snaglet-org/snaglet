import {
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { formatTableName } from '@snaglet/shared/utils';
import { BoxIcon, ChatBubbleIcon, DocIcon, TableIcon } from '@desktop/components/Icons';
import { ProjectIcon } from '@desktop/components/Icons/ProjectIcon';
import { formatFieldValue } from '@desktop/utils/formatAsYouType';
import { rowIndent } from './treeUtils';
import type { CreatableKind } from './types';
import styles from './WorkspaceTree.module.scss';

/** What an inline draft row names: a creatable node, or a table. */
type DraftKind = CreatableKind | 'table';

interface DraftRowProps {
  depth: number;
  kind: DraftKind;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

// A project drafts with the project icon and the tree's project row style
// (`rowProject`), a doc with the doc row style (`rowDoc`, the Doc color), so
// each reads as the row it is about to become.
const KIND_DRAFT: Record<DraftKind, { icon: ReactNode; placeholder: string }> = {
  container: { icon: <BoxIcon />, placeholder: 'New container' },
  project: { icon: <ProjectIcon />, placeholder: 'New project' },
  doc: { icon: <DocIcon />, placeholder: 'New doc' },
  thread: { icon: <ChatBubbleIcon />, placeholder: 'New thread' },
  table: { icon: <TableIcon />, placeholder: 'New table' },
};

/**
 * Inline name prompt for the tree's create flow. A thread or a table drafts
 * as the first row of its scope's Threads / Tables group; anything else among
 * the parent's children.
 *
 * Enter or blur commits, Escape cancels, and the row is one-shot: the blur
 * that follows Enter or Escape (the row unmounts with focus inside) must not
 * create the item a second time, or at all after Escape. A table's name is
 * its SQL name, so it formats as typed (`formatTableName`); every other kind
 * keeps the text as typed.
 */
export function DraftRow({ depth, kind, inputRef, onCommit, onCancel }: DraftRowProps) {
  const [value, setValue] = useState('');
  const settledRef = useRef(false);
  const { icon, placeholder } = KIND_DRAFT[kind];

  const commit = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  };

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) =>
    setValue(kind === 'table' ? formatFieldValue(e.target, formatTableName) : e.target.value);

  return (
    <div className={styles.rowGroup}>
      <div
        className={
          kind === 'project'
            ? `${styles.row} ${styles.rowProject}`
            : kind === 'doc'
              ? `${styles.row} ${styles.rowDoc}`
              : styles.row
        }
        style={{ paddingLeft: rowIndent(depth) }}
      >
        <span className={styles.chevron} aria-hidden></span>
        <span className={styles.icon} aria-hidden>
          {icon}
        </span>
        <input
          ref={inputRef}
          className={styles.draftInput}
          value={value}
          onChange={onChange}
          onKeyDown={onKey}
          onBlur={commit}
          placeholder={placeholder}
          spellCheck={false}
          aria-label={`${kind} name`}
        />
      </div>
    </div>
  );
}
