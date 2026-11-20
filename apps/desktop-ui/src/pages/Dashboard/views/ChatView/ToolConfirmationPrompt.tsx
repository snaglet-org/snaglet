import type { ReactElement } from 'react';
import type {
  ToolConfirmationDecision,
  ToolConfirmationRequestPayload,
} from '@snaglet/shared/types';
import { Button } from '@desktop/components/controls/Button/Button';
import { InteractionPanel } from './InteractionPanel/InteractionPanel';
import styles from './ToolConfirmationPrompt.module.scss';

interface ToolConfirmationPromptProps {
  request: ToolConfirmationRequestPayload;
  agentName?: string;
  onRespond: (callId: string, decision: ToolConfirmationDecision) => void;
}

/** Approve/deny UI for a tool call parked by the server confirmation gate. */
export function ToolConfirmationPrompt({
  request,
  agentName,
  onRespond,
}: ToolConfirmationPromptProps): ReactElement {
  const actor = agentName?.trim() || 'An agent';
  return (
    <InteractionPanel
      title="$ tool confirmation"
      detail="approval required"
      resizeLabel="Resize tool confirmation panel"
      footer={
        <div className={styles.actions} role="group" aria-label="Tool confirmation actions">
          <Button variant="danger" size="md" onClick={() => onRespond(request.callId, 'deny')}>
            Deny
          </Button>
          {request.mode === 'allow_list' ? (
            <>
              <Button
                variant="neutral"
                size="md"
                onClick={() => onRespond(request.callId, 'allow_thread')}
              >
                Allow for this thread
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={() => onRespond(request.callId, 'allow_agent')}
              >
                Always allow
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="md"
              onClick={() => onRespond(request.callId, 'approve_once')}
            >
              Approve
            </Button>
          )}
        </div>
      }
    >
      <p className={styles.preamble}>{actor} wants to run:</p>
      <p className={styles.toolName}>{request.toolName}</p>
      {request.mode === 'allow_list' ? (
        <p className={styles.policyNote}>This tool is not in the agent's allow-list.</p>
      ) : null}
      <div className={styles.inputLabel}>Input</div>
      <pre className={styles.inputSummary}>{request.inputSummary}</pre>
    </InteractionPanel>
  );
}
