/**
 * doc op outline through the real ToolExecutor and database: one entry per
 * heading of the stored source, with the line `#L` reads use and the anchor
 * `#h=` reads use, so an outline leads straight to one block.
 */
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Docs, getDb } from '@snaglet/db';
import type { Actor } from '@snaglet/shared/types/workspace-events';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
}));

import { runWithActor } from '@server/realtime/actorContext';
import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';

const ACTOR: Actor = { actorKind: 'user', actorId: 'user-outline-test', actorName: 'Outliner' };
const agentTool = {
  agentId: '',
  tool: { id: 'doc', name: 'Doc' },
  settings: {},
  requiresConfirmation: false,
} as unknown as Parameters<typeof toolExecutor.execute>[1];

async function run(input: Record<string, unknown>) {
  return runWithActor(ACTOR, () => toolExecutor.execute({ name: 'doc', input }, agentTool));
}

async function ok<T>(input: Record<string, unknown>): Promise<T> {
  const result = await run(input);
  if (!result.success) throw new Error(`doc call failed: ${result.error}`);
  return JSON.parse(result.output) as T;
}

interface Outline {
  id: string;
  title: string;
  total_lines: number;
  headings: Array<{ level: number; text: string; line: number; anchor: string }>;
}

const GUIDE = [
  '# Guide', //  1
  '', //  2
  '## Setup', //  3
  'Install it.', //  4
  '', //  5
  '### Setup', //  6  same name, deeper level
  'Details.', //  7
  '', //  8
  '## Usage', //  9
  '```md', // 10
  '## Not a heading', // 11
  '```', // 12
  '## Usage', // 13  a repeat at the same level
  'Again.', // 14
].join('\n');

beforeAll(async () => {
  await toolRegistry.load();
});

describe('doc op outline', () => {
  it('lists nested and repeated headings with lines and anchors, skipping code', async () => {
    await Docs.create({ id: 'doc-outline-guide', title: 'Guide', content: GUIDE });
    const out = await ok<Outline>({ op: 'outline', id: 'doc-outline-guide' });
    expect(out).toEqual({
      id: 'doc-outline-guide',
      title: 'Guide',
      total_lines: 14,
      headings: [
        { level: 1, text: 'Guide', line: 1, anchor: '#h=guide' },
        { level: 2, text: 'Setup', line: 3, anchor: '#h2=setup' },
        { level: 3, text: 'Setup', line: 6, anchor: '#h3=setup' },
        { level: 2, text: 'Usage', line: 9, anchor: '#h=usage' },
        { level: 2, text: 'Usage', line: 13, anchor: '#h=usage-1' },
      ],
    });
  });

  it('leads to the block: the line reads with #L and the anchor with #h=', async () => {
    const out = await ok<Outline>({ op: 'outline', id: 'doc-outline-guide' });
    const usage = out.headings[4]!;
    const byLines = await ok<{ content: string }>({
      op: 'get',
      id: `doc-outline-guide#L${usage.line}-L${out.total_lines}`,
    });
    const byAnchor = await ok<{ content: string }>({
      op: 'get',
      id: `doc-outline-guide${usage.anchor}`,
    });
    expect(byLines.content).toBe('## Usage\nAgain.');
    expect(byAnchor.content).toBe('## Usage\nAgain.');
    const setup = await ok<{ content: string }>({
      op: 'get',
      id: `doc-outline-guide${out.headings[2]!.anchor}`,
    });
    expect(setup.content).toBe('### Setup\nDetails.');
  });

  it('counts only the stored source: transcluded docs add no headings or lines', async () => {
    await Docs.create({
      id: 'doc-outline-shared',
      title: 'Shared',
      content: '# Shared\n\n## Inside',
    });
    await Docs.create({
      id: 'doc-outline-host',
      title: 'Host',
      content: '# Host\n![Shared](doc-outline-shared)\n## After',
    });
    const out = await ok<Outline>({ op: 'outline', id: 'doc-outline-host' });
    expect(out.total_lines).toBe(3);
    expect(out.headings).toEqual([
      { level: 1, text: 'Host', line: 1, anchor: '#h=host' },
      { level: 2, text: 'After', line: 3, anchor: '#h=after' },
    ]);
  });

  it('outlines an empty doc as nothing', async () => {
    await Docs.create({ id: 'doc-outline-empty', title: 'Empty', content: '' });
    expect(await ok<Outline>({ op: 'outline', id: 'doc-outline-empty' })).toEqual({
      id: 'doc-outline-empty',
      title: 'Empty',
      total_lines: 0,
      headings: [],
    });
  });

  it('reads an archived doc only with include_archived', async () => {
    await Docs.create({ id: 'doc-outline-old', title: 'Old', content: '# Old' });
    await getDb().query(`UPDATE nodes SET archived = true, archived_at = now() WHERE id = $1`, [
      'doc-outline-old',
    ]);
    const refused = await run({ op: 'outline', id: 'doc-outline-old' });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('pass include_archived: true');
    const out = await ok<Outline>({ op: 'outline', id: 'doc-outline-old', include_archived: true });
    expect(out.headings).toEqual([{ level: 1, text: 'Old', line: 1, anchor: '#h=old' }]);
  });
});
