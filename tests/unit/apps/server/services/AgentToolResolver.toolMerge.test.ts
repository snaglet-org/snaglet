/**
 * The real discovery/authoring merge: stored access lists naming the alias
 * ids must mean exactly one op, using the shipped aliases and definitions.
 */
import { evaluateToolPermission } from '@server/services/ToolService/lib/toolPermission';
import toolDefinition from '@server/services/ToolService/tools/system/tool/definition';
import customToolDefinition from '@server/services/ToolService/tools/system/custom-tool/definition';
import { resolveToolId } from '@snaglet/shared/utils/toolAliases';
import type { ToolAccessConfig } from '@snaglet/shared/types';

const opsOf = (def: { parameters_schema: unknown }): string[] =>
  ((def.parameters_schema as { properties: Record<string, { enum?: string[] }> }).properties.op
    .enum ?? []) as string[];

const access = (partial: Partial<ToolAccessConfig>): ToolAccessConfig => ({
  mode: 'all',
  allowList: [],
  denyList: [],
  ...partial,
});

const allowedOps = (id: string, ops: string[], partial: Partial<ToolAccessConfig>): string[] =>
  ops.filter((op) => evaluateToolPermission(access(partial), id, { op }).decision === 'allow');

describe('tool / custom_tool merge with the shipped aliases', () => {
  it('advertises the documented ops', () => {
    expect(opsOf(toolDefinition)).toEqual(['search', 'schema']);
    expect(opsOf(customToolDefinition)).toEqual(['create', 'update']);
  });

  it('pins each retired id to one op', () => {
    expect(resolveToolId('search_tools')).toMatchObject({ id: 'tool', op: 'search' });
    expect(resolveToolId('list_tools')).toMatchObject({ id: 'tool', op: 'search' });
    expect(resolveToolId('get_tool_schema')).toMatchObject({ id: 'tool', op: 'schema' });
    expect(resolveToolId('create_tool')).toMatchObject({ id: 'custom_tool', op: 'create' });
  });

  it('a caller-supplied op cannot override alias pinning', () => {
    expect(
      resolveToolId('create_tool').transformParams?.({ op: 'update', name: 'x' })
    ).toMatchObject({
      op: 'create',
    });
    expect(
      resolveToolId('get_tool_schema').transformParams?.({ op: 'search', tool: 'doc' })
    ).toMatchObject({ op: 'schema', name: 'doc' });
    expect(resolveToolId('list_tools').transformParams?.({})).toMatchObject({
      op: 'search',
      mode: 'list',
    });
  });

  it('a legacy create_tool allow grants only create, never update', () => {
    expect(
      allowedOps('custom_tool', opsOf(customToolDefinition), {
        mode: 'allow_list',
        allowList: ['create_tool'],
      })
    ).toEqual(['create']);
  });

  it('the discovery tool is always available, so no rule gates search or schema', () => {
    for (const entry of ['search_tools', 'get_tool_schema', 'tool']) {
      expect(
        allowedOps('tool', opsOf(toolDefinition), { mode: 'deny_list', denyList: [entry] })
      ).toEqual(['search', 'schema']);
    }
  });

  it('authoring stays gateable: denying custom_tool or create_tool blocks its ops', () => {
    expect(
      allowedOps('custom_tool', opsOf(customToolDefinition), {
        mode: 'deny_list',
        denyList: ['custom_tool'],
      })
    ).toEqual([]);
    expect(
      allowedOps('custom_tool', opsOf(customToolDefinition), {
        mode: 'deny_list',
        denyList: ['create_tool'],
      })
    ).toEqual(['update']);
  });
});

describe('custom_tool op confirmation gate', () => {
  it('declares create and update as confirm-gated ops', () => {
    // both ops build and run agent-authored Node code as the user.
    expect(customToolDefinition.destructiveOps).toEqual(['create', 'update']);
  });

  it('puts custom_tool in the guarded tool set that seeds new agents', async () => {
    const { getGuardedToolIds } = await import('@server/services/ToolService/lib/guardedTools');
    expect(await getGuardedToolIds()).toContain('custom_tool');
  });
});
