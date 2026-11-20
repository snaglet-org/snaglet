/**
 * The real hook merge: stored access lists naming create_hook / run_hook must
 * mean exactly one op of `hook`, using the shipped aliases and definition.
 */
import { evaluateToolPermission } from '@server/services/ToolService/lib/toolPermission';
import hookDefinition from '@server/services/ToolService/tools/hooks/hook/definition';
import { resolveToolId } from '@snaglet/shared/utils/toolAliases';
import type { ToolAccessConfig } from '@snaglet/shared/types';

const OPS = (hookDefinition.parameters_schema.properties as Record<string, { enum?: string[] }>).op
  .enum as string[];

const access = (partial: Partial<ToolAccessConfig>): ToolAccessConfig => ({
  mode: 'all',
  allowList: [],
  denyList: [],
  ...partial,
});

const allowedOps = (partial: Partial<ToolAccessConfig>): string[] =>
  OPS.filter((op) => evaluateToolPermission(access(partial), 'hook', { op }).decision === 'allow');

describe('hook merge with the shipped aliases', () => {
  it('advertises exactly the six ops', () => {
    expect(OPS).toEqual(['create', 'run', 'update', 'enable', 'disable', 'run_as']);
  });

  it('pins each retired id to one op of hook', () => {
    expect(resolveToolId('create_hook')).toMatchObject({ id: 'hook', op: 'create' });
    expect(resolveToolId('run_hook')).toMatchObject({ id: 'hook', op: 'run' });
  });

  it('a caller-supplied op cannot override alias pinning', () => {
    expect(resolveToolId('run_hook').transformParams?.({ op: 'enable', name: 'x' })).toMatchObject({
      op: 'run',
    });
    expect(resolveToolId('create_hook').transformParams?.({ op: 'run' })).toMatchObject({
      op: 'create',
    });
  });

  it('a legacy run_hook allow grants only run', () => {
    expect(allowedOps({ mode: 'allow_list', allowList: ['run_hook'] })).toEqual(['run']);
  });

  it('a legacy create_hook allow grants only create', () => {
    expect(allowedOps({ mode: 'allow_list', allowList: ['create_hook'] })).toEqual(['create']);
  });

  it('denying run_hook blocks run but not the other ops', () => {
    expect(allowedOps({ mode: 'deny_list', denyList: ['run_hook'] })).toEqual([
      'create',
      'update',
      'enable',
      'disable',
      'run_as',
    ]);
  });

  it('denying the canonical tool blocks every op', () => {
    expect(allowedOps({ mode: 'deny_list', denyList: ['hook'] })).toEqual([]);
  });
});

describe('hook op confirmation gate', () => {
  it('declares create, run, update, enable and run_as (and only those) as confirm-gated ops', async () => {
    const { default: definition } =
      await import('@server/services/ToolService/tools/hooks/hook/definition');
    // create writes agent code, run executes a saved hook's code, and
    // update/enable/run_as stage or hand code an actor's access — all run as
    // the user. disable only turns a hook off, so it stays ungated.
    expect(definition.destructiveOps).toEqual(['create', 'run', 'update', 'enable', 'run_as']);
  });

  it('puts hook in the guarded tool set that seeds new agents', async () => {
    const { getGuardedToolIds } = await import('@server/services/ToolService/lib/guardedTools');
    expect(await getGuardedToolIds()).toContain('hook');
  });
});
