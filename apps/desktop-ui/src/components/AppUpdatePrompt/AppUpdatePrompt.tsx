import type { FC } from 'react';
import { ConfirmModal } from '@desktop/components/Modal';
import { countActiveAgentProcesses, useAgentWork } from '@desktop/utils/agentWorkState';
import {
  confirmAppUpdate,
  dismissAppUpdateOffer,
  useAppUpdateState,
} from '@desktop/utils/appUpdate';

function runningAgentsLine(count: number): string | null {
  if (count === 0) return null;
  return count === 1
    ? '1 agent is working. It will be stopped.'
    : `${count} agents are working. They will be stopped.`;
}

/**
 * The question asked before an update installs, opened by `offerAppUpdate`
 * from the update notification or Settings → Updates. Install starts the
 * download; Later closes it and changes nothing. Mounted once at the app root.
 */
export const AppUpdatePrompt: FC = () => {
  const { offer } = useAppUpdateState();
  const agents = countActiveAgentProcesses(useAgentWork());
  if (!offer) return null;
  const agentsLine = runningAgentsLine(agents);
  return (
    <ConfirmModal
      title={`Snaglet ${offer} is available`}
      confirmLabel="Install"
      cancelLabel="Later"
      onConfirm={() => {
        void confirmAppUpdate();
      }}
      onCancel={dismissAppUpdateOffer}
    >
      {agentsLine ? ['Install and restart?', agentsLine] : 'Install and restart?'}
    </ConfirmModal>
  );
};
