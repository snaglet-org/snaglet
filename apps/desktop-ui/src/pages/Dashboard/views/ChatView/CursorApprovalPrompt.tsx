import { useEffect, useState, type ReactElement } from 'react';
import type { CursorApprovalDecision } from '@snaglet/shared/constants/agentCursor';
import { Button } from '@desktop/components/controls/Button/Button';
import { FlowerIcon } from '@desktop/components/agentCursor/FlowerIcon';
import {
  approvalButtons,
  approvalPhrase,
  type PendingRequest,
} from '@desktop/components/AgentCursorApproval/requestReducer';
import {
  useCursorApprovalHost,
  useCursorApprovalState,
} from '@desktop/components/AgentCursorApproval/cursorApprovalStore';
import { InteractionPanel } from './InteractionPanel/InteractionPanel';
import styles from './CursorApprovalPrompt.module.scss';

interface PromptProps {
  request: PendingRequest;
  onAnswer: (req: PendingRequest, decision: CursorApprovalDecision) => void;
}

/** Approval for an agent using the cursor or browser: same panel as `ask`. */
function CursorApprovalPrompt({ request, onAnswer }: PromptProps): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const secondsLeft = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
  const labels = approvalButtons(request);

  return (
    <InteractionPanel
      title="$ agent access"
      detail={request.expired ? 'expired' : `approval required · ${secondsLeft}s`}
      resizeLabel="Resize agent access panel"
      footer={
        request.expired ? null : (
          <div className={styles.actions} role="group" aria-label="Agent access actions">
            <Button variant="danger" size="md" onClick={() => onAnswer(request, 'deny')}>
              {labels.deny}
            </Button>
            {labels.session ? (
              <Button
                variant="neutral"
                size="md"
                onClick={() => onAnswer(request, 'allow-session')}
              >
                {labels.session}
              </Button>
            ) : null}
            <Button variant="primary" size="md" onClick={() => onAnswer(request, 'allow')}>
              {labels.allow}
            </Button>
          </div>
        )
      }
    >
      {request.expired ? (
        <p className={styles.meta}>This request expired.</p>
      ) : (
        <>
          <div className={styles.head}>
            <FlowerIcon flower={request.flower} color={request.color} size={28} />
            <p className={styles.who}>
              <strong>{request.name}</strong> {approvalPhrase(request)}
            </p>
          </div>
          {request.kind === 'browser' && request.profile ? (
            <p className={styles.meta}>Profile: {request.profile}</p>
          ) : null}
          {request.reason ? <p className={styles.reason}>{request.reason}</p> : null}
        </>
      )}
    </InteractionPanel>
  );
}

/** Renders every pending approval; mount once per chat pane, above the composer. */
export function CursorApprovalPrompts(): ReactElement | null {
  useCursorApprovalHost();
  const { requests, answer } = useCursorApprovalState();
  if (!answer || requests.length === 0) return null;
  return (
    <>
      {requests.map((r) => (
        <CursorApprovalPrompt key={r.requestId} request={r} onAnswer={answer} />
      ))}
    </>
  );
}
