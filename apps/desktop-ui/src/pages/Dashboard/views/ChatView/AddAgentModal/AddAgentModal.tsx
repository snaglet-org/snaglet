import { useEffect, useMemo, useState, type FC } from 'react';
import { Button, Modal, Select } from '@desktop/components';
import { agentsApi, threadsApi } from '@desktop/utils/api';
import type { SnagletAgent } from '@snaglet/shared/types';
import styles from './AddAgentModal.module.scss';
import { getErrorMessage } from '@snaglet/shared/utils';

interface AddAgentModalProps {
  threadId: string;
  /** Agent IDs already on the thread — hidden from the picker. */
  existingAgentIds: string[];
  onClose: () => void;
  /** Called after a successful add so the parent can refetch. */
  onAdded: () => void;
}

/**
 * Modal: pick one agent from the registry and POST to
 * `/threads/:id/participants`. Keeps a thin scope on purpose — the
 * picker is the simplest thing that works; richer config (role,
 * model overrides) can come later.
 */
export const AddAgentModal: FC<AddAgentModalProps> = ({
  threadId,
  existingAgentIds,
  onClose,
  onAdded,
}) => {
  const [agents, setAgents] = useState<SnagletAgent[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    agentsApi
      .list()
      .then((ags) => {
        if (!canceled) setAgents(ags);
      })
      .catch((err) => {
        if (!canceled) setError(getErrorMessage(err, 'Failed to load agents'));
      });
    return () => {
      canceled = true;
    };
  }, []);

  const available = useMemo(() => {
    if (!agents) return [];
    const excluded = new Set(existingAgentIds);
    return agents.filter((a) => !excluded.has(a.id));
  }, [agents, existingAgentIds]);

  const submit = async () => {
    if (!selectedId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await threadsApi.addParticipant(threadId, selectedId);
      onAdded();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to add agent'));
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <Modal.Header>
        <span className={styles.title}>Add agent to thread</span>
        <Button variant="ghost" size="sm" iconOnly aria-label="Close" onClick={onClose}>
          ×
        </Button>
      </Modal.Header>
      <Modal.Body>
        {agents === null && <div className={styles.status}>Loading agents…</div>}
        {agents !== null && available.length === 0 && !error && (
          <div className={styles.status}>
            No more agents to add — every agent is already on this thread.
          </div>
        )}
        {available.length > 0 && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Agent</span>
            <Select
              value={selectedId ?? ''}
              onChange={(e) => setSelectedId(e.target.value || null)}
              autoFocus
            >
              <option value="" disabled>
                Select an agent…
              </option>
              {available.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.role ? ` — ${agent.role}` : ''}
                </option>
              ))}
            </Select>
          </label>
        )}
        {error && <div className={styles.error}>{error}</div>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={submit}
          disabled={!selectedId}
          loading={submitting}
          loadingText="Adding…"
        >
          Add agent
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
