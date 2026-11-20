import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClarificationQuestion, ClarificationRequestPayload } from '@snaglet/shared/types';

const ws = vi.hoisted(() => ({ listeners: new Set<(m: unknown) => void>() }));
vi.mock('@desktop/utils/api', () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
  getApiUrl: (p: string) => p,
}));
vi.mock('@desktop/ws/useWs', () => ({
  useWs: () => ({
    addMessageListener: (fn: (m: unknown) => void) => {
      ws.listeners.add(fn);
      return () => ws.listeners.delete(fn);
    },
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    connectionState: 'closed',
  }),
}));

import { resetAgentSpecCache } from '@desktop/components/agentCursor/useAgentSpecs';
import { AgentCursorOverlay } from './AgentCursorOverlay';
import { publishClarification, resetClarificationStore } from './clarificationStore';

const single: ClarificationQuestion = {
  id: 'q1',
  prompt: 'Send the email?',
  type: 'single_select',
  options: ['yes', 'no'],
  allowOther: true,
};
const multi: ClarificationQuestion = {
  id: 'q2',
  prompt: 'Which scopes?',
  type: 'multi_select',
  options: ['read', 'write', 'admin'],
};
const text: ClarificationQuestion = { id: 'q3', prompt: 'Any note?', type: 'text' };

const payload = (questions: ClarificationQuestion[], agentId = 'agent-a') =>
  ({
    threadId: 'thread-1',
    callId: 'call-1',
    agentId,
    request: { questions },
  }) as ClarificationRequestPayload;

const cursor = (agentId = 'agent-a') =>
  act(() => {
    for (const fn of ws.listeners)
      fn({
        type: 'agent:cursor',
        payload: {
          agentId,
          name: 'Test Agent',
          x: window.screenX + 300,
          y: window.screenY + 300,
          state: 'move',
          label: 'Working',
          flower: 'tulip',
          color: '#ef5d8a',
          holderAgentId: null,
        },
      });
  });

const ask = (questions: ClarificationQuestion[], agentId?: string) => {
  const respond = vi.fn();
  act(() => {
    publishClarification({ request: payload(questions, agentId), respond });
  });
  return respond;
};

beforeEach(() => {
  resetAgentSpecCache();
  resetClarificationStore();
  sessionStorage.clear();
});
afterEach(() => resetClarificationStore());

describe('ClarificationCard', () => {
  it('shows next to the flower when the asking agent has a cursor, and not otherwise', () => {
    render(<AgentCursorOverlay />);
    ask([single]);
    expect(screen.queryByTestId('agent-ask-card')).toBeNull();
    cursor();
    expect(screen.getByTestId('agent-ask-card')).toBeInTheDocument();
    expect(screen.getByText('Send the email?')).toBeInTheDocument();
  });

  it('is not interactive outside the card and absent from the standalone overlay', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    const { container, unmount } = render(<AgentCursorOverlay />);
    ask([single]);
    cursor();
    expect(container.querySelector('.snaglet-agent-asks')).not.toBeNull();
    unmount();
    render(<AgentCursorOverlay standalone />);
    cursor();
    expect(screen.queryByTestId('agent-ask-card')).toBeNull();
  });

  it('single select: arrows move, Enter picks and submits the same response', async () => {
    const user = userEvent.setup();
    render(<AgentCursorOverlay />);
    const respond = ask([single]);
    cursor();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(respond).toHaveBeenCalledWith('call-1', 'answered', {
      q1: { selected: ['no'], text: null },
    });
  });

  it('multi select: Space toggles, Enter submits', async () => {
    const user = userEvent.setup();
    render(<AgentCursorOverlay />);
    const respond = ask([multi]);
    cursor();
    await user.keyboard('{Enter}'); // nothing picked yet: Enter toggles the focused option
    await user.keyboard('{ArrowDown}{ArrowDown} {Enter}');
    expect(respond).toHaveBeenCalledWith('call-1', 'answered', {
      q2: { selected: ['read', 'admin'], text: null },
    });
  });

  it('text: typing goes straight into the field, Enter sends', async () => {
    const user = userEvent.setup();
    render(<AgentCursorOverlay />);
    const respond = ask([text]);
    cursor();
    await user.keyboard('hello{Enter}');
    expect(respond).toHaveBeenCalledWith('call-1', 'answered', { q3: { text: 'hello' } });
  });

  it('typing on a select with Other goes to the Other field', async () => {
    const user = userEvent.setup();
    render(<AgentCursorOverlay />);
    const respond = ask([single]);
    cursor();
    await user.keyboard('maybe{Enter}');
    expect(respond).toHaveBeenCalledWith('call-1', 'answered', {
      q1: { selected: [], text: 'maybe' },
    });
  });

  it('steps through several questions with Enter', async () => {
    const user = userEvent.setup();
    render(<AgentCursorOverlay />);
    const respond = ask([single, text]);
    cursor();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Any note?')).toBeInTheDocument();
    await user.keyboard('ok{Enter}');
    expect(respond).toHaveBeenCalledWith('call-1', 'answered', {
      q1: { selected: ['yes'], text: null },
      q3: { text: 'ok' },
    });
  });

  it('Esc dismisses with the panel status and does not stop the agent', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    render(<AgentCursorOverlay />);
    const respond = ask([single]);
    cursor();
    await user.keyboard('{Escape}');
    expect(respond).toHaveBeenCalledWith('call-1', 'dismissed', {});
    expect(fetchSpy).not.toHaveBeenCalledWith('/computer/stop', expect.anything());
    fetchSpy.mockRestore();
  });

  it('leaves keys alone while another field has focus, until the focus shortcut', async () => {
    const user = userEvent.setup();
    render(
      <>
        <input aria-label="composer" />
        <AgentCursorOverlay />
      </>
    );
    const respond = ask([single]);
    cursor();
    await user.click(screen.getByLabelText('composer'));
    await user.keyboard('abc{Enter}');
    expect(respond).not.toHaveBeenCalled();
    expect(screen.getByLabelText('composer')).toHaveValue('abc');
    await user.keyboard('{Control>}.{/Control}');
    expect(screen.getByTestId('agent-ask-card')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('the card shows only once the asking agent has a flower, and goes when the ask is withdrawn', () => {
    render(<AgentCursorOverlay />);
    ask([single]);
    expect(screen.queryByTestId('agent-ask-card')).toBeNull();
    cursor();
    expect(screen.getByTestId('agent-ask-card')).toBeInTheDocument();
    act(() => resetClarificationStore());
    expect(screen.queryByTestId('agent-ask-card')).toBeNull();
  });
});
