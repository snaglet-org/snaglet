/**
 * pane(op) — get_user_pane_layout (layout) and navigate_user_pane (navigate)
 * as one tool. Each op hands its handler exactly the input that alias takes
 * (minus `op`); navigate's fields on a layout are refused before anything
 * runs; each alias id pins exactly one op.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const log: string[] = [];
const calls: Record<string, unknown[]> = {};
function record(name: string, input: unknown) {
  log.push(name);
  (calls[name] ??= []).push(input);
}

jest.mock('@server/services/ToolService/handlers/workspace/paneLayout', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('layout', input), 'layout')),
}));
jest.mock('@server/services/ToolService/handlers/workspace/navigatePane', () => ({
  __esModule: true,
  default: jest.fn(async (input: unknown) => (record('navigate', input), 'navigated')),
}));

import paneTool from '@server/services/ToolService/tools/workspace/pane/tool';
import definition from '@server/services/ToolService/tools/workspace/pane/definition';
import { evaluateOpAccess, resolveToolId, transformToolAliasParams } from '@snaglet/shared/utils';

const run = (input: Record<string, unknown>) => paneTool(input, {}, undefined);

beforeEach(() => {
  log.length = 0;
  for (const k of Object.keys(calls)) delete calls[k];
});

describe('pane(op) dispatch', () => {
  it('layout → get_user_pane_layout handler with no fields', async () => {
    await run({ op: 'layout' });
    expect(calls.layout).toEqual([{}]);
  });

  it('navigate → navigate_user_pane handler input, unchanged minus op', async () => {
    const input = {
      target: { kind: 'doc', id: 'doc-1' },
      mode: 'split',
      split_zone: 'left',
      new_pane_ratio: 0.3,
      pane_key: 'p1',
    };
    await run({ op: 'navigate', ...input });
    expect(calls.navigate).toEqual([input]);
  });

  it.each([['pane_key'], ['mode'], ['split_zone'], ['new_pane_ratio'], ['target']])(
    'layout refuses navigate’s %s before anything runs',
    async (field) => {
      await expect(run({ op: 'layout', [field]: 'x' })).rejects.toThrow('Nothing was changed');
      expect(log).toEqual([]);
    }
  );

  it('refuses a missing or unknown op', async () => {
    await expect(run({ target: { kind: 'doc', id: 'd' } })).rejects.toThrow('op is required');
    await expect(run({ op: 'open' })).rejects.toThrow('op is required');
    expect(log).toEqual([]);
  });
});

describe('pane access rules stay op-level (real alias registry)', () => {
  const opOf = (oldId: string, params: Record<string, unknown> = {}) =>
    transformToolAliasParams(resolveToolId(oldId), params).op as string;
  const allowOnly = (entry: string) => ({ mode: 'allow_list', allowList: [entry], denyList: [] });
  const denyOnly = (entry: string) => ({ mode: 'deny_list', allowList: [], denyList: [entry] });
  const verdict = (access: ReturnType<typeof allowOnly>, op: string) =>
    evaluateOpAccess(access as never, 'pane', op).decision;

  it.each([
    ['get_user_pane_layout', 'layout'],
    ['navigate_user_pane', 'navigate'],
  ])('%s pins pane op %s', (oldId, op) => {
    expect(resolveToolId(oldId).id).toBe('pane');
    expect(resolveToolId(oldId).op).toBe(op);
    expect(opOf(oldId, { op: op === 'layout' ? 'navigate' : 'layout' })).toBe(op);
  });

  it('allow get_user_pane_layout does not grant navigate; deny navigate_user_pane leaves layout', () => {
    expect(verdict(allowOnly('get_user_pane_layout'), 'layout')).toBe('allow');
    expect(verdict(allowOnly('get_user_pane_layout'), 'navigate')).not.toBe('allow');
    expect(verdict(denyOnly('navigate_user_pane'), 'navigate')).toBe('deny');
    expect(verdict(denyOnly('navigate_user_pane'), 'layout')).toBe('allow');
  });
});

describe('pane definition', () => {
  it('ops are layout | navigate; core; nothing confirm-gated', () => {
    const schema = definition.parameters_schema as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(schema.properties.op.enum).toEqual(['layout', 'navigate']);
    expect(schema.required).toEqual(['op']);
    expect(definition.tier).toBe('core');
    expect(definition.destructive).toBeUndefined();
    expect(definition.destructiveOps).toBeUndefined();
  });
});
