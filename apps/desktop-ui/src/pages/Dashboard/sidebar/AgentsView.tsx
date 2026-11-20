import { useCallback, useEffect, useRef, useState, type FC, type FormEvent } from 'react';
import { AgentsList } from '@desktop/components/AgentsList';
import { Button, Modal, TextInput } from '@desktop/components';
import { agentsApi } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import type { SnagletAgent } from '@snaglet/shared/types';
import { SidebarView } from './SidebarView';
import styles from './AgentsView.module.scss';

interface AgentsViewProps {
  onAgentClick: (agent: SnagletAgent) => void;
  selectedAgentId: string | null;
  /**
   * Cross-view search reveal: id of the agent to scroll to + pulse.
   * Set when the user picks an agent result from the unified sidebar
   * search while on another view.
   */
  revealNodeId?: string | null;
  /** Bumped per reveal request so the effect re-fires for the same id. */
  revealNonce?: number;
  /** Bumped by workspace `agent.updated` events so the roster refetches. */
  refreshNonce?: number;
}

/**
 * AgentsView — sidebar view that lists every agent in the workspace.
 * Click a row to surface the agent's chat / config in the active pane.
 * The header `+` opens a small create-agent modal (name required, role
 * optional); on submit we create the agent, refresh the list, and drop
 * the user into the new agent's pane for further config.
 */
export const AgentsView: FC<AgentsViewProps> = ({
  onAgentClick,
  selectedAgentId,
  revealNodeId = null,
  revealNonce = 0,
  refreshNonce = 0,
}) => {
  const [createdRefreshNonce, setCreatedRefreshNonce] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [pulseId, setPulseId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Cross-view search reveal: scroll the agent row into view + pulse it.
  // Re-runs on every revealNonce bump so picking the same id twice still
  // triggers the highlight. AgentsList async-fetches its rows from the
  // API, so the requested row might not exist in the DOM yet when the
  // reveal request arrives — poll for up to a second (50ms cadence)
  // before giving up.
  useEffect(() => {
    if (!revealNodeId) return;
    let canceled = false;
    let attempts = 0;
    const tryReveal = () => {
      if (canceled) return;
      const el = listRef.current?.querySelector<HTMLElement>(
        `[data-reveal-id="${CSS.escape(revealNodeId)}"]`
      );
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setPulseId(revealNodeId);
        window.setTimeout(() => {
          if (!canceled) setPulseId(null);
        }, 1600);
        return;
      }
      attempts += 1;
      if (attempts < 20) {
        window.setTimeout(tryReveal, 50);
      }
    };
    window.setTimeout(tryReveal, 0);
    return () => {
      canceled = true;
    };
  }, [revealNodeId, revealNonce]);

  const handleCreated = useCallback(
    (agent: SnagletAgent) => {
      setCreatedRefreshNonce((n) => n + 1);
      setModalOpen(false);
      onAgentClick(agent);
    },
    [onAgentClick]
  );

  return (
    <SidebarView
      title="Agents"
      actions={
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          className={styles.addBtn}
          onClick={() => setModalOpen(true)}
          title="New agent"
          aria-label="New agent"
        >
          +
        </Button>
      }
    >
      <div ref={listRef}>
        <AgentsList
          onAgentClick={onAgentClick}
          selectedAgentId={selectedAgentId}
          refreshNonce={refreshNonce + createdRefreshNonce}
          pulseAgentId={pulseId}
        />
      </div>
      {modalOpen && <NewAgentModal onClose={() => setModalOpen(false)} onCreated={handleCreated} />}
    </SidebarView>
  );
};

interface NewAgentModalProps {
  onClose: () => void;
  onCreated: (agent: SnagletAgent) => void;
}

/** The New agent form: the header `+` here, and the Get started pane through the Dashboard. */
export const NewAgentModal: FC<NewAgentModalProps> = ({ onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !submitting;

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      setSubmitting(true);
      setError(null);
      try {
        const trimmedRole = role.trim();
        const agent = await agentsApi.create({
          name: trimmedName,
          ...(trimmedRole ? { role: trimmedRole } : {}),
        });
        onCreated(agent);
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to create agent'));
        setSubmitting(false);
      }
    },
    [canSubmit, onCreated, role, trimmedName]
  );

  return (
    <Modal onClose={submitting ? () => undefined : onClose}>
      <form onSubmit={handleSubmit} className={styles.modalForm}>
        <Modal.Header>New agent</Modal.Header>
        <Modal.Body>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Name</span>
            <TextInput
              ref={nameRef}
              type="text"
              fullWidth
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Researcher"
              maxLength={120}
              required
              disabled={submitting}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              Role <span className={styles.fieldHint}>(optional)</span>
            </span>
            <TextInput
              type="text"
              fullWidth
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. Machine learning professor"
              maxLength={200}
              disabled={submitting}
            />
          </label>
          {error && <p className={styles.formError}>{error}</p>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" size="md" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={!canSubmit}
            loading={submitting}
            loadingText="Creating…"
          >
            Create
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
};
