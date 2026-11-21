import type { FC } from 'react';
import { ConfirmModal } from '@desktop/components/Modal';
import { countActiveAgentProcesses, useAgentWork } from '@desktop/utils/agentWorkState';
import {
  confirmAppUpdate,
  dismissAppUpdateOffer,
  useAppUpdateState,
} from '@desktop/utils/appUpdate';

/** Restarting stops agents, hooks and background jobs alike. */
function stopsLine(agents: number): string {
  if (agents === 0) return 'Anything still running stops.';
  return `Anything still running stops, including ${agents === 1 ? '1 working agent' : `${agents} working agents`}.`;
}

/**
 * The question asked before an update installs, opened by `offerAppUpdate`
 * from the update notification or Settings → Updates; the title names the
 * release that will be installed. Install starts the download; Later closes
 * it and changes nothing. Mounted once at the app root.
 */
export const AppUpdatePrompt: FC = () => {
  const { offer } = useAppUpdateState();
  const agents = countActiveAgentProcesses(useAgentWork());
  if (!offer) return null;
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
      {['Install and restart?', stopsLine(agents)]}
    </ConfirmModal>
  );
};
