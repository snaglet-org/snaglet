/**
 * missingToolLookup — what a run learns about a tool its start-of-run map
 * lacks: reachable now (a custom tool created mid-run), blocked by the
 * agent's access, or unknown. Resolution goes through the real resolver
 * entry points (mocked here), with the run's own access and overrides.
 */

const resolveAgentToolsMock = jest.fn();
const resolveForExecutionMock = jest.fn();
jest.mock('@server/services/AgentToolResolver', () => ({
  SKILL_TOOL_ID: 'skill',
  resolveAgentTools: (...a: unknown[]) => resolveAgentToolsMock(...a),
  resolveAgentToolsForExecution: (...a: unknown[]) => resolveForExecutionMock(...a),
}));
jest.mock('@server/config/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { createMissingToolLookup } from '@server/services/SocketService/handlers/chatPhases/missingToolLookup';
import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';

function resolved(id: string): ResolvedAgentTool {
  return {
    agentId: 'agent-1',
    tool: { id, name: id, aliases: [] } as unknown as ResolvedAgentTool['tool'],
    settings: {},
    requiresConfirmation: false,
  };
}

const ALL = { mode: 'all' as const, allowList: [], denyList: [] };
const DENY_THEME = { mode: 'deny_list' as const, allowList: [], denyList: ['change_color_theme'] };
const ALLOW_DOC = { mode: 'allow_list' as const, allowList: ['doc'], denyList: [] };
const threadOverrides = { file: { requiresConfirmation: true } };

beforeEach(() => {
  resolveAgentToolsMock.mockReset();
  resolveForExecutionMock.mockReset();
});

describe('createMissingToolLookup', () => {
  it('finds a tool that became reachable, resolved with the run’s access and overrides', async () => {
    resolveAgentToolsMock.mockResolvedValue([resolved('doc'), resolved('fax_document')]);
    const lookup = createMissingToolLookup('agent-1', { access: ALL, threadOverrides });

    const result = await lookup('fax_document');

    expect(result).toEqual({ kind: 'reachable', tool: resolved('fax_document') });
    expect(resolveAgentToolsMock).toHaveBeenCalledWith('agent-1', {
      access: ALL,
      threadOverrides,
      mcpServerOverride: undefined,
    });
    expect(resolveForExecutionMock).not.toHaveBeenCalled();
  });

  it('reports a tool the agent’s deny list hides as blocked', async () => {
    resolveAgentToolsMock.mockResolvedValue([resolved('doc')]);
    resolveForExecutionMock.mockResolvedValue([resolved('doc'), resolved('change_color_theme')]);
    const lookup = createMissingToolLookup('agent-1', { access: DENY_THEME });

    const result = await lookup('change_color_theme');

    expect(result).toEqual({
      kind: 'blocked',
      tool: resolved('change_color_theme').tool,
      by: 'agent',
    });
  });

  it('names the thread when the run’s access is a thread override', async () => {
    resolveAgentToolsMock.mockResolvedValue([resolved('doc')]);
    resolveForExecutionMock.mockResolvedValue([resolved('doc'), resolved('change_color_theme')]);
    const lookup = createMissingToolLookup('agent-1', { access: DENY_THEME, accessFrom: 'thread' });

    expect(await lookup('change_color_theme')).toEqual({
      kind: 'blocked',
      tool: resolved('change_color_theme').tool,
      by: 'thread',
    });
  });

  it('in allow-list mode resolves against the whole catalog (an unlisted call asks a person)', async () => {
    resolveForExecutionMock.mockResolvedValue([resolved('doc'), resolved('change_color_theme')]);
    const lookup = createMissingToolLookup('agent-1', { access: ALLOW_DOC });

    expect(await lookup('change_color_theme')).toEqual({
      kind: 'reachable',
      tool: resolved('change_color_theme'),
    });
    expect(resolveAgentToolsMock).not.toHaveBeenCalled();
    expect(await lookup('nope')).toEqual({ kind: 'unknown' });
  });

  it('a name nothing resolves is unknown', async () => {
    resolveAgentToolsMock.mockResolvedValue([resolved('doc')]);
    resolveForExecutionMock.mockResolvedValue([resolved('doc')]);
    const lookup = createMissingToolLookup('agent-1', { access: ALL });

    expect(await lookup('fax_document')).toEqual({ kind: 'unknown' });
  });

  it('never surfaces `skill`, which the run leaves out for agents without skills', async () => {
    resolveAgentToolsMock.mockResolvedValue([resolved('skill')]);
    resolveForExecutionMock.mockResolvedValue([resolved('skill')]);
    const lookup = createMissingToolLookup('agent-1', { access: ALL });

    expect(await lookup('skill')).toEqual({ kind: 'unknown' });
  });

  it('a resolver failure reads as unknown', async () => {
    resolveAgentToolsMock.mockRejectedValue(new Error('db down'));
    const lookup = createMissingToolLookup('agent-1', { access: ALL });

    expect(await lookup('doc')).toEqual({ kind: 'unknown' });
  });
});
