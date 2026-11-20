import { useMemo, type FC } from 'react';
import { HookIcon } from '@desktop/components/Icons';
import { useAgentWork } from '@desktop/utils/agentWorkState';
import { useHookRuns } from '@desktop/utils/hookRunState';
import { useStatusBarSlot } from '../StatusBarContext';
import type { StatusBarSlot } from '../types';
import { HookRunsPopover } from './HookRunsPopover';

/**
 * Dedicated hook activity indicator. Hook executions are operational work,
 * not agents, so they live beside the active-agents slot instead of inflating
 * its count.
 */
export const HookRunsSlot: FC = () => {
  const runs = useHookRuns();
  const work = useAgentWork();
  const activeCount = work.filter((item) => item.kind === 'hook-run').length;
  const recent = useMemo(() => runs.slice(0, 25), [runs]);

  const slot = useMemo<StatusBarSlot>(
    () => ({
      id: 'hook-runs',
      zone: 'left',
      order: 2,
      item: {
        type: 'toggle',
        label: `${activeCount} script${activeCount === 1 ? '' : 's'} running`,
        tone: activeCount > 0 ? 'primary' : 'muted',
        title:
          activeCount > 0
            ? `${activeCount} script${activeCount === 1 ? '' : 's'} running — click for recent runs`
            : 'No scripts running — click for recent runs',
        icon: <HookIcon />,
        render: () => <HookRunsPopover runs={recent} />,
      },
    }),
    [activeCount, recent]
  );

  useStatusBarSlot(slot);
  return null;
};
