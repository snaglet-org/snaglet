import { type CSSProperties, type FC, useCallback, useEffect, useRef, useState } from 'react';
import type { CursorApprovalDecision } from '@snaglet/shared/constants/agentCursor';
import { FlowerIcon } from '@desktop/components/agentCursor/FlowerIcon';
import { getApiUrl } from '@desktop/utils/api';
import { useCursorRequests, type RequestAction } from './useCursorRequests';
import { approvalButtons, approvalPhrase, type PendingRequest } from './requestReducer';
import { publishCursorApprovals, useCursorApprovalState } from './cursorApprovalStore';
import './AgentCursorApproval.css';

const EXPIRED_FLASH_MS = 2500;

const Card: FC<{
  req: PendingRequest;
  focusFirst: boolean;
  onAnswer: (req: PendingRequest, d: CursorApprovalDecision) => void;
}> = ({ req, focusFirst, onAnswer }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [total] = useState(() => Math.max(1, req.expiresAt - Date.now()));

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(t);
  }, []);
  // Focus the card itself (not a button) so Enter/Esc work but nothing is pre-armed.
  useEffect(() => {
    if (focusFirst) ref.current?.focus({ preventScroll: true });
  }, [focusFirst]);

  const frac = Math.max(0, Math.min(1, (req.expiresAt - now) / total));
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // let focused buttons act on their own
    if (e.key === 'Enter') {
      e.preventDefault();
      onAnswer(req, 'allow');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onAnswer(req, 'deny');
    }
  };

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-label={`${req.name} ${approvalPhrase(req)}`}
      className={`snaglet-cursor-approval__card${req.expired ? ' is-expired' : ''}`}
      style={{ '--snaglet-cursor-agent-color': req.color } as CSSProperties}
      onKeyDown={onKeyDown}
      data-testid="agent-cursor-approval-card"
    >
      {req.expired ? (
        <p className="snaglet-cursor-approval__expired">This request expired.</p>
      ) : (
        <>
          <div className="snaglet-cursor-approval__head">
            <FlowerIcon flower={req.flower} color={req.color} size={32} />
            <div>
              <strong>{req.name}</strong> {approvalPhrase(req)}
              {req.kind === 'browser' && req.profile ? (
                <div className="snaglet-cursor-approval__profile">Profile: {req.profile}</div>
              ) : null}
              {req.reason ? (
                <blockquote className="snaglet-cursor-approval__reason">“{req.reason}”</blockquote>
              ) : null}
            </div>
          </div>
          <div className="snaglet-cursor-approval__bar" aria-hidden>
            <div className="snaglet-cursor-approval__barfill" style={{ width: `${frac * 100}%` }} />
          </div>
          <div className="snaglet-cursor-approval__actions">
            <button type="button" onClick={() => onAnswer(req, 'allow')}>
              {approvalButtons(req).allow}
            </button>
            {approvalButtons(req).session ? (
              <button type="button" onClick={() => onAnswer(req, 'allow-session')}>
                {approvalButtons(req).session}
              </button>
            ) : null}
            <button type="button" className="is-deny" onClick={() => onAnswer(req, 'deny')}>
              {approvalButtons(req).deny}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export const AgentCursorApproval: FC = () => {
  const { requests, dispatch } = useCursorRequests();
  const dispatchRef = useRef<(a: RequestAction) => void>(dispatch);
  dispatchRef.current = dispatch;

  const answer = useCallback(
    (req: PendingRequest, decision: CursorApprovalDecision) => {
      dispatch({ type: 'resolve', requestId: req.requestId });
      fetch(getApiUrl('/computer/approval'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: req.requestId, decision }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status));
        })
        .catch(() => {
          // Re-show briefly as expired (answered elsewhere / timed out / gone).
          dispatchRef.current({ type: 'add', event: req });
          dispatchRef.current({ type: 'expired', requestId: req.requestId });
          window.setTimeout(
            () => dispatchRef.current({ type: 'resolve', requestId: req.requestId }),
            EXPIRED_FLASH_MS
          );
        });
    },
    [dispatch]
  );

  // Dev-only trigger.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __snagletCursorApprovalDemo?: (name?: string) => void };
    w.__snagletCursorApprovalDemo = (name = 'Demo') => {
      dispatchRef.current({
        type: 'add',
        event: {
          requestId: `demo-${Date.now()}`,
          agentId: `demo-${name}`,
          name,
          flower: 'tulip',
          color: '#ef5d8a',
          reason: 'Open the settings page and toggle dark mode',
          expiresAt: Date.now() + 30000,
        },
      });
    };
    return () => {
      delete (window as unknown as { __snagletCursorApprovalDemo?: unknown })
        .__snagletCursorApprovalDemo;
    };
  }, []);

  // Chat panes show the request as an `ask`-style panel; this floating card is
  // only the fallback when no pane is mounted to host it.
  useEffect(() => {
    publishCursorApprovals(requests, answer);
  }, [requests, answer]);
  const { hosts } = useCursorApprovalState();

  if (requests.length === 0 || hosts > 0) return null;
  return (
    <div className="snaglet-cursor-approval" data-testid="agent-cursor-approval">
      {requests.map((r, i) => (
        <Card key={r.requestId} req={r} focusFirst={i === 0} onAnswer={answer} />
      ))}
    </div>
  );
};
