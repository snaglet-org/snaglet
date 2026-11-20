import { useEffect, useState, type FC, type ReactNode } from 'react';
import type { WorkspaceEditorAutosaveState } from '@desktop/features/rich-markdown/workspace-editor';
import {
  docsApi,
  membersApi,
  settingsApi,
  type DocRecord,
  type MemberOption,
} from '@desktop/utils/api';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { formatShortDate, isRecord, relativeFromNow } from '@snaglet/shared/utils';
import { PropertiesGroup } from '../shared/PropertiesPanel';
import styles from '../shared/NodeProperties.module.scss';

const EDITOR_SAVE_LABELS: Record<WorkspaceEditorAutosaveState, string | null> = {
  pristine: null,
  dirty: 'unsaved',
  saving: 'saving…',
  saved: 'saved',
  error: 'save failed',
};

/**
 * DocProperties — the doc's Properties panel contents (PropertiesPanel).
 *
 * A doc carries no task state: a task is a row in a Database table, and its
 * status / due / assignee live on that row (optionally linked to this doc
 * through a `doc` relation for its prose). So the panel is read-only:
 * author, created/updated and the editor's autosave state as an Info list.
 * DocView passes the Outline (the doc's headings) and the Versions group
 * (Snapshot and the version list) as children, below Info; md/txt stays in
 * the pane topbar.
 * The container path is intentionally NOT duplicated here — the pane chrome
 * breadcrumb already shows it.
 */
interface DocPropertiesProps {
  docId: string;
  /** Extra groups placed after Info. */
  children?: ReactNode;
  editorSaveState?: WorkspaceEditorAutosaveState;
  editorSaveError?: string | null;
  /**
   * The doc's latest `updatedAt` as the pane knows it. Saves (local or from
   * another client) move it, while the record fetched on open does not.
   */
  updatedAt?: string;
}

/** Whether the first-run seed record (`onboarding.seed`) lists this doc among the ones it made. */
function seedMadeDoc(seed: unknown, docId: string): boolean {
  return isRecord(seed) && isRecord(seed.docs) && Object.values(seed.docs).includes(docId);
}

/** The later of two ISO timestamps; either may be missing. */
function laterStamp(a: string | undefined, b: string | undefined): string | undefined {
  if (!a || !b) return a ?? b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

export const DocProperties: FC<DocPropertiesProps> = ({
  docId,
  children,
  editorSaveState = 'pristine',
  editorSaveError = null,
  updatedAt,
}) => {
  const [doc, setDoc] = useState<DocRecord | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);
  // Editor announced by the latest save of this doc (`doc-saved`, local or
  // relayed from the server's `doc.saved`). The record fetched on open is a
  // snapshot, so a save since then wins; a save that names no editor keeps
  // whatever is shown.
  const [savedEditedBy, setSavedEditedBy] = useState<string | null>(null);
  // The starter docs have no author; the seed record says Snaglet made them.
  const [seeded, setSeeded] = useState(false);

  // Refetch the full doc (the tree snapshot the pane passes down lacks the
  // attribution fields) whenever the selected doc changes.
  useEffect(() => {
    let canceled = false;
    setDoc(null);
    docsApi
      .get(docId)
      .then((d) => {
        if (!canceled) setDoc(d);
      })
      .catch((err: unknown) => {
        // Leave null — the panel simply shows loading.
        console.error('DocProperties: failed to load doc', err);
      });
    return () => {
      canceled = true;
    };
  }, [docId]);

  useEffect(() => {
    setSavedEditedBy(null);
    return onLibraryEvent((event) => {
      if (event.type === 'doc-saved' && event.id === docId && event.lastEditedBy) {
        setSavedEditedBy(event.lastEditedBy);
      }
    });
  }, [docId]);

  const authorless = doc !== null && doc.createdBy == null;
  useEffect(() => {
    setSeeded(false);
    if (!authorless) return;
    let canceled = false;
    settingsApi
      .get('onboarding', 'seed')
      .then((setting) => {
        if (!canceled) setSeeded(seedMadeDoc(setting.value, docId));
      })
      .catch((err: unknown) => {
        // Without the record the author stays unknown.
        console.error('DocProperties: failed to load the seed record', err);
      });
    return () => {
      canceled = true;
    };
  }, [authorless, docId]);

  // Members list resolves the created_by / last_edited_by ids; fetched once.
  useEffect(() => {
    let canceled = false;
    membersApi
      .list()
      .then((rows) => {
        if (!canceled) setMembers(rows);
      })
      .catch((err: unknown) => {
        // Attribution just shows the raw ids if this fails.
        console.error('DocProperties: failed to load members', err);
      });
    return () => {
      canceled = true;
    };
  }, []);

  const memberName = (id: string | null | undefined): string | null =>
    id == null ? null : (members.find((m) => m.id === id)?.displayName ?? id);
  const createdByName = memberName(doc?.createdBy) ?? (seeded ? 'Snaglet' : '—');
  const editedByName = memberName(savedEditedBy ?? doc?.lastEditedBy);
  const createdStamp = doc?.createdAt ? formatShortDate(doc.createdAt) : '—';
  const latestUpdatedAt = laterStamp(doc?.updatedAt, updatedAt);
  const updatedStamp = latestUpdatedAt ? relativeFromNow(latestUpdatedAt) : '—';
  const editorSaveLabel = EDITOR_SAVE_LABELS[editorSaveState];

  return (
    <>
      <PropertiesGroup label="Info">
        <dl className={styles.infoList} data-tid="docReadonlyMeta">
          <dt>Created by</dt>
          <dd>{createdByName}</dd>
          <dt>Created</dt>
          <dd>{createdStamp}</dd>
          <dt>Updated</dt>
          <dd>{updatedStamp}</dd>
          {editedByName && (
            <>
              <dt>Edited by</dt>
              <dd>{editedByName}</dd>
            </>
          )}
          {editorSaveLabel && (
            <>
              <dt>Status</dt>
              <dd
                role="status"
                aria-live="polite"
                title={editorSaveError ?? undefined}
                data-state={editorSaveState === 'error' ? 'error' : undefined}
              >
                {editorSaveLabel}
              </dd>
            </>
          )}
        </dl>
      </PropertiesGroup>
      {children}
    </>
  );
};
