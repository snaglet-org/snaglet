/**
 * Pane chrome and history titles for an agent come from the agent snapshot
 * stored in the pane selection. A rename made anywhere (an agent's tool,
 * another window) or missed while offline must reach them without a reload.
 */
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import { agentsApi } from '@desktop/utils/api';
import { emitAgentEvent } from '@desktop/utils/agentEvents';
import { createLeaf, type LayoutNode } from '../layout/paneTree';
import { useAgentSelectionSync } from './useAgentSelectionSync';

vi.mock('@desktop/utils/api', () => ({ agentsApi: { get: vi.fn() } }));

const get = vi.mocked(agentsApi.get);
const agent = (id: string, name: string) => ({ id, name }) as unknown as SnagletAgent;
const actor = { actorId: 'agent-venus', actorKind: 'agent' as const, actorName: 'Venus' };

function renderSync(initial: LayoutNode) {
  return renderHook(() => {
    const [layout, setLayout] = useState<LayoutNode>(initial);
    useAgentSelectionSync(layout, setLayout);
    return layout;
  });
}

beforeEach(() => get.mockReset());

describe('useAgentSelectionSync', () => {
  it('renames the pane and its history after the agent is renamed', async () => {
    const { result } = renderSync(createLeaf({ kind: 'agent', agent: agent('agent-1', 'Ada') }));
    get.mockResolvedValue(agent('agent-1', 'Ada Prime'));

    await act(async () => {
      emitAgentEvent({
        type: 'agent.updated',
        agentId: 'agent-1',
        changed: ['name'],
        ts: '2026-11-16T10:00:00.000Z',
        actor,
      });
    });

    expect(get).toHaveBeenCalledWith('agent-1');
    expect(result.current).toMatchObject({
      selection: { kind: 'agent', agent: { name: 'Ada Prime' } },
      history: { entries: [{ kind: 'agent', agent: { name: 'Ada Prime' } }] },
    });
  });

  it('fetches nothing for a change that leaves the name alone, or an agent no pane shows', async () => {
    renderSync(createLeaf({ kind: 'agent', agent: agent('agent-1', 'Ada') }));

    await act(async () => {
      emitAgentEvent({
        type: 'agent.updated',
        agentId: 'agent-1',
        changed: ['systemPrompt'],
        ts: '2026-11-16T10:00:00.000Z',
        actor,
      });
      emitAgentEvent({
        type: 'agent.updated',
        agentId: 'agent-2',
        changed: ['name'],
        ts: '2026-11-16T10:00:00.000Z',
        actor,
      });
    });

    expect(get).not.toHaveBeenCalled();
  });

  it('rereads every shown agent after a reconnect', async () => {
    const { result } = renderSync(createLeaf({ kind: 'agent', agent: agent('agent-1', 'Ada') }));
    get.mockResolvedValue(agent('agent-1', 'Renamed offline'));

    await act(async () => {
      emitAgentEvent({ type: 'agents.invalidated' });
    });

    expect(result.current).toMatchObject({
      selection: { kind: 'agent', agent: { name: 'Renamed offline' } },
    });
  });
});
