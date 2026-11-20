import { useEffect, useState, type FC } from 'react';
import type {
  ClarificationAnswer,
  ClarificationRequestPayload,
  ClarificationStatus,
  ToolConfirmationDecision,
  ToolConfirmationRequestPayload,
} from '@snaglet/shared/types';
import { ASK_EVENT_CHANNEL, ASK_SYNC } from '@snaglet/shared/types';
import { FlowerAvatar } from '@desktop/components/agentCursor/FlowerAvatar';
import { useAgentSpecs } from '@desktop/components/agentCursor/useAgentSpecs';
import { ClarificationCard } from '@desktop/components/AgentCursorOverlay/ClarificationCard';
import { usePendingClarifications } from '@desktop/components/AgentCursorOverlay/clarificationStore';
import { useShowAgentPopups } from '@desktop/utils/displayPrefs';
import { useWs } from '@desktop/ws/useWs';
import { agentsApi, getApiUrl } from '@desktop/utils/api';
import { applyFrameToFeed, dropFromFeed, useAskFeed } from './askFeedStore';
import { useViewedThreads } from './viewedThreads';
import './AgentPopups.css';

const AVATAR_SIZE = 28;
const NO_THREADS: ReadonlySet<string> = new Set();
const ASK_WINDOW_POLL_MS = 4000;

/** True while the native ask window (a separate OS window) is running. */
function useAskWindowActive(poll: boolean): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!poll) return undefined;
    let live = true;
    const check = (): void => {
      fetch(getApiUrl('/computer/ask-overlay-status'))
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { active?: boolean } | null) => live && setActive(body?.active === true))
        .catch(() => live && setActive(false));
    };
    check();
    const timer = window.setInterval(check, ASK_WINDOW_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [poll]);
  return active;
}

/** Keep the global ask feed in sync while popups are enabled. */
function useAskFeedSync(enabled: boolean): void {
  const { addMessageListener, send, subscribe, unsubscribe, connectionState } = useWs();

  useEffect(() => {
    if (!enabled) return undefined;
    return addMessageListener((msg) =>
      applyFrameToFeed(msg as { type?: string; payload?: unknown })
    );
  }, [enabled, addMessageListener]);

  useEffect(() => {
    if (!enabled || connectionState !== 'open') return undefined;
    subscribe(ASK_EVENT_CHANNEL);
    // The snapshot replaces local state, so a reconnect also drops anything that
    // settled while the socket was down.
    send({ type: ASK_SYNC, payload: {} });
    return () => unsubscribe(ASK_EVENT_CHANNEL);
  }, [enabled, connectionState, subscribe, unsubscribe, send]);
}

function useAgentNames(): (agentId: string | undefined) => string {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    agentsApi
      .list()
      .then((agents) => live && setNames(new Map(agents.map((a) => [a.id, a.name]))))
      .catch((err) => console.debug('[ask] agent list failed', err));
    return () => {
      live = false;
    };
  }, []);
  return (id) => (id ? names.get(id) : undefined) ?? 'An agent';
}

/**
 * Pop-up stack for agent asks (Triage questions and tool permissions) whose chat
 * is not on screen: the agent's avatar beside the question card, so the user
 * can answer without opening the chat. Asks for a thread that has a chat pane
 * open stay in that pane's composer; asks already shown on a cursor card are
 * not duplicated. Controlled by the "Show agent popups" setting.
 */
export const AgentPopups: FC<{ standalone?: boolean }> = ({ standalone = false }) => {
  const prefEnabled = useShowAgentPopups();
  const systemWindowActive = useAskWindowActive(!standalone && prefEnabled);
  // The native ask window shows every ask itself, so the in-app stack stands down
  // while it runs; the window ignores the in-app preference (it is only launched
  // on purpose) and has no chat panes of its own.
  const enabled = standalone || (prefEnabled && !systemWindowActive);
  useAskFeedSync(enabled);
  const feed = useAskFeed();
  const viewedInApp = useViewedThreads();
  const viewed: ReadonlySet<string> = standalone ? NO_THREADS : viewedInApp;
  const cursorAsks = usePendingClarifications();
  const { send } = useWs();
  const { specFor } = useAgentSpecs();
  const nameOf = useAgentNames();

  if (!enabled) return null;

  const clarifications = feed.clarifications.filter((c) => !viewed.has(c.threadId));
  const confirmations = feed.confirmations.filter((c) => !viewed.has(c.threadId));
  if (clarifications.length === 0 && confirmations.length === 0) return null;

  const answer = (
    req: ClarificationRequestPayload,
    status: ClarificationStatus,
    answers: Record<string, ClarificationAnswer>
  ): void => {
    send({
      type: 'socket:clarification:response',
      payload: { threadId: req.threadId, callId: req.callId, status, answers },
    });
    dropFromFeed(req.callId);
  };
  const decide = (
    req: ToolConfirmationRequestPayload,
    decision: ToolConfirmationDecision
  ): void => {
    send({
      type: 'socket:tool:confirm',
      payload: { threadId: req.threadId, callId: req.callId, decision },
    });
    dropFromFeed(req.callId);
  };

  const avatar = (agentId: string | undefined) =>
    agentId ? (
      <div className="snaglet-agent-popup__avatar">
        <FlowerAvatar spec={specFor(agentId)} emotion="curious" size={AVATAR_SIZE} />
      </div>
    ) : null;

  return (
    <div className="snaglet-agent-popups" data-testid="agent-popups">
      {clarifications
        .filter((c) => !cursorAsks.some((p) => p.request.callId === c.callId))
        .map((req) => (
          <div className="snaglet-agent-popup" key={req.callId}>
            {avatar(req.agentId)}
            <div className="snaglet-agent-popup__body">
              <ClarificationCard
                inline
                request={req}
                respond={(_callId, status, answers) => answer(req, status, answers)}
                anchor={{ x: 0, y: 0 }}
                agentName={nameOf(req.agentId)}
              />
            </div>
          </div>
        ))}
      {confirmations.map((req) => (
        <div className="snaglet-agent-popup" key={req.callId}>
          {avatar(req.agentId)}
          <div
            className="snaglet-agent-popup__body snaglet-agent-ask snaglet-agent-ask--inline"
            role="alertdialog"
            aria-label={`${nameOf(req.agentId)} needs permission`}
            data-testid="agent-popup-confirmation"
          >
            <div className="snaglet-agent-ask__head">
              <strong>{nameOf(req.agentId)}</strong>
              <span> {req.mode === 'allow_list' ? 'is not allowed to run' : 'wants to run'}</span>
            </div>
            <p className="snaglet-agent-popup__tool">{req.toolName}</p>
            {req.inputSummary ? (
              <pre className="snaglet-agent-popup__summary">{req.inputSummary}</pre>
            ) : null}
            <div className="snaglet-agent-ask__foot">
              <div className="snaglet-agent-ask__actions">
                <button type="button" onClick={() => decide(req, 'deny')}>
                  Deny
                </button>
                {req.mode === 'allow_list' ? (
                  <>
                    <button type="button" onClick={() => decide(req, 'approve_once')}>
                      Allow once
                    </button>
                    <button type="button" onClick={() => decide(req, 'allow_thread')}>
                      This thread
                    </button>
                    <button type="button" onClick={() => decide(req, 'allow_agent')}>
                      Always allow
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => decide(req, 'approve_once')}>
                    Approve
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
