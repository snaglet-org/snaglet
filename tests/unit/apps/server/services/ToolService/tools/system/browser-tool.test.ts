/**
 * browser tool — replies stay plain JSON. Page text comes from outside Snaglet, so
 * the outside-content notice is added where results enter an agent's context
 * (toolDispatch), not here: hook and tool code calling `browser` through
 * /api/tools/execute can JSON.parse the output.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mockRun = jest.fn();
jest.mock('@server/services/BrowserController', () => ({
  getBrowserController: () => ({ run: (...args: unknown[]) => mockRun(...args) }),
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: jest.fn().mockResolvedValue({ name: 'Test Agent A' }) },
}));

import tool from '@server/services/ToolService/tools/system/browser/tool';
import definition from '@server/services/ToolService/tools/system/browser/definition';
import {
  MAX_BATCH_HOLD_MS,
  MAX_HOLD_KEYS,
  MAX_HOLD_MS,
} from '@server/services/BrowserController/keyHold';

const ctx = { agentId: 'test-agent-a' } as Parameters<typeof tool>[2];

describe('browser tool — raw JSON replies', () => {
  beforeEach(() => mockRun.mockReset());

  it.each(['read', 'snapshot', 'open', 'click'])('%s reply parses as JSON', async (op) => {
    const reply = { ok: true, url: 'https://example.com', text: 'page text' };
    mockRun.mockResolvedValue(reply);
    const out = String(await tool({ op }, {}, ctx));
    expect(JSON.parse(out)).toEqual(reply);
  });

  it('passes the run’s abort signal to the controller', async () => {
    mockRun.mockResolvedValue({ ok: true });
    const ac = new AbortController();
    await tool({ op: 'press', key: 'd', hold_ms: 100 }, {}, { ...ctx, signal: ac.signal });
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'test-agent-a' }),
      { op: 'press', key: 'd', hold_ms: 100 },
      { signal: ac.signal }
    );
  });
});

describe('browser tool — held keys are discoverable', () => {
  const props = definition.parameters_schema.properties as Record<
    string,
    { description?: string; maxItems?: number; minimum?: number; maximum?: number }
  >;

  it('the schema documents keys and hold_ms with the enforced limits', () => {
    expect(props.keys).toMatchObject({ type: 'array', maxItems: MAX_HOLD_KEYS });
    expect(props.hold_ms).toMatchObject({ type: 'integer', minimum: 1, maximum: MAX_HOLD_MS });
    expect(props.op.description).toMatch(/hold_ms/);
    expect(props.steps.description).toMatch(String(MAX_BATCH_HOLD_MS));
  });

  it('TOOL.md documents the hold', () => {
    const md = readFileSync(
      path.join(
        __dirname,
        '../../../../../../../../apps/server/src/services/ToolService/tools/system/browser/TOOL.md'
      ),
      'utf8'
    );
    expect(md).toMatch(/hold_ms/);
    expect(md).toMatch(/keys/);
    expect(md).toMatch(String(MAX_HOLD_MS));
  });
});
