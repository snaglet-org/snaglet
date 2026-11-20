import { useMemo, type FC } from 'react';
import { countActiveAgentProcesses, useAgentWork } from '@desktop/utils/agentWorkState';
import { cn } from '@desktop/utils/classNames';
import { useStatusBarSlot } from '../StatusBarContext';
import type { StatusBarSlot } from '../types';
import { ActiveAgentsPopover } from './ActiveAgentsPopover';
import styles from './ActiveAgentsSlot.module.scss';

/**
 * ActiveAgentsSlot — headless status-bar consumer (renders null) that pushes
 * the active-agents indicator into the left zone, next to the connection
 * health readout.
 *
 * The chip shows the count of active agent processes: dimmed "0"
 * at rest, highlighted (primary tone + pressed pill) while anything runs.
 * Clicking opens the shared toggle popover with a scrollable list of every
 * live run / executing hook (see ActiveAgentsPopover). Data flows push-only:
 * the agentWorkState store is seeded once per connect and updated by
 * `agent.work_*` workspace events — this component never polls.
 */
export const ActiveAgentsSlot: FC = () => {
  const work = useAgentWork();
  const agentWork = useMemo(() => work.filter((item) => item.kind === 'thread-run'), [work]);
  const count = countActiveAgentProcesses(agentWork);

  const slot = useMemo<StatusBarSlot>(
    () => ({
      id: 'active-agents',
      zone: 'left',
      order: 1,
      item: {
        type: 'toggle',
        // Plain-language label, not a bare number — "2 active agent processes".
        label: `${count} active agent process${count === 1 ? '' : 'es'}`,
        // Match the status bar's own vocabulary: the Connected readout's
        // success tone while agents work, quiet muted at rest. No pressed
        // pill / primary tint — that read as foreign chrome.
        tone: count > 0 ? 'success' : 'muted',
        title:
          count === 0
            ? 'No agent processes running'
            : `${count} agent process${count === 1 ? '' : 'es'} running — click for details`,
        icon: <span className={cn(styles.glyph, count > 0 && styles.glyphActive)} />,
        render: ({ close }) => <ActiveAgentsPopover work={agentWork} onClose={close} />,
      },
    }),
    [agentWork, count]
  );

  useStatusBarSlot(slot);
  return null;
};
