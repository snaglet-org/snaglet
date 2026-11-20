import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import type { SnagletAgent } from '@snaglet/shared/types';
import { Button, Checkbox, Modal, TextInput } from '@desktop/components';
import { agentsApi } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import styles from './ThreadAgentPickerModal.module.scss';

interface ThreadAgentPickerModalProps {
  threadTitle: string;
  onCancel: () => void;
  onCreate: (agentIds: string[]) => void | Promise<void>;
}

/**
 * Required agent selection gate for creating a thread from the workspace tree.
 * The thread is not created until at least one agent is selected and confirmed.
 */
export const ThreadAgentPickerModal: FC<ThreadAgentPickerModalProps> = ({
  threadTitle,
  onCancel,
  onCreate,
}) => {
  const [agents, setAgents] = useState<SnagletAgent[] | null>(null);
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let canceled = false;
    agentsApi
      .list()
      .then((rows) => {
        if (!canceled) {
          setAgents([...rows].sort((a, b) => a.name.localeCompare(b.name)));
        }
      })
      .catch((err) => {
        if (!canceled) setError(getErrorMessage(err, 'Failed to load agents'));
      });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    if (!agents) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return agents;
    return agents.filter((agent) => {
      const haystack = [agent.name, agent.role, agent.modelId].filter(Boolean).join(' ');
      return haystack.toLowerCase().includes(needle);
    });
  }, [agents, query]);

  const toggleAgent = (agentId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const submit = async () => {
    if (selectedIds.size === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(Array.from(selectedIds));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to create thread'));
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={submitting ? () => undefined : onCancel}>
      <Modal.Header>
        <span className={styles.title}>Add agents to thread</span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Close"
          onClick={onCancel}
          disabled={submitting}
        >
          x
        </Button>
      </Modal.Header>
      <Modal.Body>
        <div className={styles.threadName}>{threadTitle}</div>
        <TextInput
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agents..."
          fullWidth
          disabled={submitting || agents === null}
          aria-label="Search agents"
        />
        {agents === null && !error && <div className={styles.status}>Loading agents...</div>}
        {agents !== null && agents.length === 0 && !error && (
          <div className={styles.status}>Create an agent before creating a thread.</div>
        )}
        {agents !== null && agents.length > 0 && filtered.length === 0 && (
          <div className={styles.status}>No agents match that search.</div>
        )}
        {filtered.length > 0 && (
          <div className={styles.list} role="listbox" aria-label="Agents">
            {filtered.map((agent) => {
              const checked = selectedIds.has(agent.id);
              const role = agent.role?.trim();
              return (
                <div
                  key={agent.id}
                  tabIndex={submitting ? -1 : 0}
                  className={`${styles.row} ${checked ? styles.rowSelected : ''}`}
                  onClick={() => toggleAgent(agent.id)}
                  onKeyDown={(e) => {
                    if (submitting) return;
                    // Only the row itself owns this handler. When focus is on the
                    // inner checkbox it activates on its own Space/Enter; letting
                    // the keydown bubble here too would toggle a second time and
                    // net-cancel, so ignore events that originated from a child.
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleAgent(agent.id);
                    }
                  }}
                  role="option"
                  aria-selected={checked}
                  aria-disabled={submitting}
                >
                  {/* The row itself toggles the agent; stop the checkbox's own
                      click from bubbling so a direct hit doesn't toggle twice. */}
                  <span className={styles.checkbox} onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={checked}
                      disabled={submitting}
                      onChange={() => toggleAgent(agent.id)}
                      aria-label={agent.name}
                    />
                  </span>
                  <span className={styles.identity}>
                    <span className={styles.name}>{agent.name || 'Untitled agent'}</span>
                    <span className={styles.meta}>{role || agent.modelId || 'No role set'}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {error && <div className={styles.error}>{error}</div>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="md" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={submit}
          disabled={selectedIds.size === 0 || agents === null}
          loading={submitting}
          loadingText="Creating..."
        >
          Create thread
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
