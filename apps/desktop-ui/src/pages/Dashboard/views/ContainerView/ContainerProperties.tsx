import { useEffect, useState, type FC } from 'react';
import {
  containersApi,
  membersApi,
  type ContainerRecord,
  type MemberOption,
} from '@desktop/utils/api';
import { Button } from '@desktop/components/controls/Button/Button';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { formatShortDate, getErrorMessage, relativeFromNow } from '@snaglet/shared/utils';
import styles from '../shared/NodeProperties.module.scss';

/**
 * ContainerAttribution — the read-only "Created by X · date · Updated Y
 * [· Edited by Z]" line for a container, in the same `.metaFooter` treatment
 * DocProperties uses. Fetches the authoritative row itself (the tree snapshot
 * a pane holds carries no attribution fields) plus the members list to turn
 * member ids into names. Shared by the folder Properties dropdown and the
 * project DetailsPanel so both render attribution through one implementation.
 */
export const ContainerAttribution: FC<{ containerId: string }> = ({ containerId }) => {
  const [container, setContainer] = useState<ContainerRecord | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);

  useEffect(() => {
    let canceled = false;
    setContainer(null);
    containersApi
      .get(containerId)
      .then((c) => {
        if (!canceled) setContainer(c);
      })
      .catch((err: unknown) => {
        // Leave null — the line shows em dashes.
        console.error('ContainerAttribution: failed to load container', err);
      });
    return () => {
      canceled = true;
    };
  }, [containerId]);

  // Members list resolves the created_by / last_edited_by member ids to names.
  useEffect(() => {
    let canceled = false;
    membersApi
      .list()
      .then((rows) => {
        if (!canceled) setMembers(rows);
      })
      .catch((err: unknown) => {
        // Attribution just shows the raw id if this fails.
        console.error('ContainerAttribution: failed to load members', err);
      });
    return () => {
      canceled = true;
    };
  }, []);

  const memberName = (id: string | null | undefined): string | null =>
    id == null ? null : (members.find((m) => m.id === id)?.displayName ?? id);
  const createdByName = memberName(container?.createdBy);
  const editedByName = memberName(container?.lastEditedBy);
  const createdStamp = container?.createdAt ? formatShortDate(container.createdAt) : '—';
  const updatedStamp = container?.updatedAt ? relativeFromNow(container.updatedAt) : '—';

  return (
    <div className={styles.metaFooter}>
      <span className={styles.readonlyInline} data-tid="containerReadonlyMeta">
        <span>Created by {createdByName ?? '—'}</span>
        <span aria-hidden>·</span>
        <span>{createdStamp}</span>
        <span aria-hidden>·</span>
        <span>Updated {updatedStamp}</span>
        {editedByName && (
          <>
            <span aria-hidden>·</span>
            <span>Edited by {editedByName}</span>
          </>
        )}
      </span>
    </div>
  );
};

/**
 * PromoteToProject — the one action a plain folder's Properties offers: turn
 * the folder into a project. The change is one-way (a project's threads and
 * tables are scoped to it, so the server refuses demotion), so the button
 * first swaps to an inline one-sentence confirm. On success the pane and the
 * sidebar repaint through the realtime `category` patch; the local
 * `tree-invalidated` emit just makes that repaint immediate for this client.
 */
const PromoteToProject: FC<{ containerId: string }> = ({ containerId }) => {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const promote = async () => {
    setSaving(true);
    setError(null);
    try {
      await containersApi.update(containerId, { category: 'project' });
      setConfirming(false);
      emitLibraryEvent({ type: 'tree-invalidated', ids: [containerId] });
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Could not make this folder a project'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.actionRow} data-tid="containerPromote">
      {confirming ? (
        <div className={styles.inlineConfirm} role="group" aria-label="Confirm make project">
          <span className={styles.hint}>
            Projects can hold threads and tables and cannot be turned back into folders.
          </span>
          <div className={styles.inlineConfirmActions}>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              variant="primary"
              onClick={() => void promote()}
              loading={saving}
              loadingText="Making project…"
            >
              Confirm
            </Button>
          </div>
        </div>
      ) : (
        <Button size="xs" variant="neutral" onClick={() => setConfirming(true)}>
          Make this a project
        </Button>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
    </div>
  );
};

/**
 * ContainerProperties — Properties panel contents for a plain (non-project)
 * folder (shown in PropertiesPanel). A folder has no editable taxonomy —
 * `project` is the only category — so it carries just the one-way "Make this
 * a project" action and the attribution line.
 *
 * Project containers get the DetailsPanel instead (folder/git/description),
 * which renders the same attribution line inline.
 */
export const ContainerProperties: FC<{
  containerId: string;
}> = ({ containerId }) => (
  <>
    <PromoteToProject containerId={containerId} />
    <ContainerAttribution containerId={containerId} />
  </>
);
