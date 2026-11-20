import { useEffect, useMemo, useState, type FC } from 'react';
import { Select } from '@desktop/components';
import { agentsApi, hooksWorkspacesApi, type HookRegistrationInfo } from '@desktop/utils/api';
import type { SnagletAgent } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import styles from './HookBuilderPanel.module.scss';

/** The select's value for "no run-as agent". */
const DEFAULT_VALUE = '';

interface HookRunAsControlProps {
  hookName: string;
  runAsAgentId: string | null;
  onSaved: (row: HookRegistrationInfo) => void;
  onError: (message: string | null) => void;
}

/**
 * Picks the agent a hook runs as. Its tool access judges the hook's calls and
 * its name goes on what the hook posts and writes; "System" is the default
 * (the event's agent, else the ghost system actor). Saved at once, like the
 * Enable toggle beside it. The list is the active top-level agents; a saved
 * agent that has since been archived still shows, marked, so the header never
 * claims a different identity than the one stored.
 */
export const HookRunAsControl: FC<HookRunAsControlProps> = ({
  hookName,
  runAsAgentId,
  onSaved,
  onError,
}) => {
  const [agents, setAgents] = useState<SnagletAgent[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let canceled = false;
    agentsApi
      .list()
      .then((rows) => {
        if (!canceled) setAgents(rows);
      })
      .catch(() => {
        // The current setting still shows; picking waits for a later open.
        if (!canceled) setAgents([]);
      });
    return () => {
      canceled = true;
    };
  }, []);

  const options = useMemo(() => {
    const listed = [...(agents ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const known = runAsAgentId === null || listed.some((agent) => agent.id === runAsAgentId);
    return { listed, unknownCurrent: known ? null : runAsAgentId };
  }, [agents, runAsAgentId]);

  const handleChange = async (value: string) => {
    // Always saved, even when it matches what is shown: re-saving System is
    // how a person clears a run as the server still holds.
    const next = value === DEFAULT_VALUE ? null : value;
    setSaving(true);
    onError(null);
    try {
      onSaved(await hooksWorkspacesApi.setRunAs(hookName, next));
    } catch (err) {
      onError(getErrorMessage(err, "Couldn't change the agent this script runs as"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <label
      className={styles.runAsControl}
      title="The agent this script acts as: its tool access applies, and what the script posts or writes carries its name. System runs as the event's agent, else the system actor."
    >
      <span className={styles.enabledLabel}>Runs as</span>
      <Select
        size="sm"
        aria-label="Runs as"
        value={runAsAgentId ?? DEFAULT_VALUE}
        disabled={saving || agents === null}
        onChange={(event) => void handleChange(event.target.value)}
      >
        <option value={DEFAULT_VALUE}>System (default)</option>
        {options.unknownCurrent && (
          <option value={options.unknownCurrent}>{options.unknownCurrent} (unavailable)</option>
        )}
        {options.listed.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </Select>
    </label>
  );
};
