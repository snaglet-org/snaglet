/**
 * Transclusions through the `doc` tool, against the real database and the
 * real ToolExecutor: in-place expansion on read, the transclusion lists, edit
 * routing to the doc that owns the text, the save-time loop guard on every
 * write path, and delete protection.
 */
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Agents, Containers, Docs, Members, getDb, getDbClient } from '@snaglet/db';
import type { Actor } from '@snaglet/shared/types/workspace-events';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
}));

import { errorHandler } from '@server/middleware';
import { runWithActor } from '@server/realtime/actorContext';
import { registerActorMemberResolver } from '@server/realtime/actorMember';
import docsRouter from '@server/domains/docs/docs.routes';
import { cloneNode } from '@server/domains/clone/NodeCloneService';
import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import * as transclusionGraph from '@server/services/transclusions/transclusionGraph';

const P = 'doc-tx-test';
const AGENT = 'test-agent-tx';
const ACTOR: Actor = { actorKind: 'agent', actorId: AGENT, actorName: 'Tx Tester' };
let agentMember = '';

const app = express();
app.use(express.json());
app.use('/api/docs', docsRouter);
app.use(errorHandler);

const agentTool = {
  agentId: '',
  tool: { id: 'doc', name: 'Doc' },
  settings: {},
  requiresConfirmation: false,
} as unknown as Parameters<typeof toolExecutor.execute>[1];

async function run(input: Record<string, unknown>) {
  return runWithActor(ACTOR, () => toolExecutor.execute({ name: 'doc', input }, agentTool));
}

async function ok<T = Record<string, unknown>>(input: Record<string, unknown>): Promise<T> {
  const result = await run(input);
  if (!result.success) throw new Error(`doc call failed: ${result.error}`);
  return JSON.parse(result.output) as T;
}

async function refused(input: Record<string, unknown>): Promise<string> {
  const result = await run(input);
  expect(result.success).toBe(false);
  return result.error ?? '';
}

let seq = 0;
/** A fresh doc id per test so cases never share state. */
function id(name: string): string {
  seq += 1;
  return `${P}-${name}-${seq}`;
}

async function seed(docId: string, title: string, content: string): Promise<void> {
  await Docs.create({ id: docId, title, content });
}

/** Write content straight to the table, bypassing every guard (stored-data cases). */
async function store(docId: string, content: string): Promise<void> {
  await getDb().query(`UPDATE docs SET content = $1 WHERE id = $2`, [content, docId]);
}

async function contentOf(docId: string): Promise<string> {
  return (await Docs.findById(docId))?.content ?? '';
}

async function snapshotsOf(docId: string): Promise<string[]> {
  const { rows } = await getDb().query<{ content: string }>(
    `SELECT content FROM doc_snapshots WHERE doc_id = $1 ORDER BY created_at`,
    [docId]
  );
  return rows.map((r) => r.content);
}

async function archive(docId: string): Promise<void> {
  await getDb().query(`UPDATE nodes SET archived = true, archived_at = now() WHERE id = $1`, [
    docId,
  ]);
}

interface DocRead {
  id: string;
  content: string;
  transclusions?: Array<{ id: string; title?: string; missing?: true; archived?: true }>;
  transcluded_in?: Array<{ id: string; title: string }>;
  lines?: Record<string, unknown>;
}

// Each test file gets its own database, so there is nothing to clean up.
beforeAll(async () => {
  await toolRegistry.load();
  await Agents.create({ id: AGENT, name: 'Tx Tester' });
  agentMember = (await Members.ensureForAgent(AGENT)).id;
  registerActorMemberResolver();
});

describe('doc get: transclusions expand in place', () => {
  it('replaces the transclusion line with the wrapped content and lists both directions', async () => {
    const a = id('a');
    const b = id('b');
    await seed(b, 'Shared terms', 'Net 30.');
    await seed(a, 'Contract', `Intro\n![Terms](${b})\nSigned.`);

    const read = await ok<DocRead>({ op: 'get', id: a });
    expect(read.content).toBe(
      `Intro\n<transcluded-doc id="${b}" title="Shared terms">\nNet 30.\n</transcluded-doc>\nSigned.`
    );
    expect(read.transclusions).toEqual([{ id: b, title: 'Shared terms' }]);
    expect(read).not.toHaveProperty('transcluded_in');
    expect(read).not.toHaveProperty('inline_references');

    const shared = await ok<DocRead>({ op: 'get', id: b });
    expect(shared.content).toBe('Net 30.');
    expect(shared.transcluded_in).toEqual([{ id: a, title: 'Contract' }]);
    expect(shared).not.toHaveProperty('transclusions');
  });

  it('returns the stored source with raw: true', async () => {
    const a = id('a');
    const b = id('b');
    await seed(b, 'B', 'b body');
    await seed(a, 'A', `x ![B](${b}) y`);
    const read = await ok<DocRead>({ op: 'get', id: a, raw: true });
    expect(read.content).toBe(`x ![B](${b}) y`);
    expect(read.transclusions).toEqual([{ id: b, title: 'B' }]);
  });

  it('nests three levels, then marks the fourth', async () => {
    const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(id);
    await seed(e, 'E', 'e body');
    await seed(d, 'D', `d ![](${e})`);
    await seed(c, 'C', `c ![](${d})`);
    await seed(b, 'B', `b ![](${c})`);
    await seed(a, 'A', `![](${b})`);
    const read = await ok<DocRead>({ op: 'get', id: a });
    expect(read.content).toContain(`<transcluded-doc id="${d}" title="D">\nd `);
    expect(read.content).toContain(`<transcluded-doc id="${e}" title="E" skipped="depth"/>`);
    expect(read.content).not.toContain('e body');
  });

  it('marks missing and archived targets in place, never as comments', async () => {
    const a = id('a');
    const gone = id('gone');
    await seed(gone, 'Gone', 'hidden');
    await seed(a, 'A', `![](${gone})`);
    await archive(gone);
    await store(a, `![](${gone})\n![](${P}-never-existed)`);
    const read = await ok<DocRead>({ op: 'get', id: a });
    expect(read.content).toBe(
      `<transcluded-doc id="${gone}" title="Gone" archived="true"/>\n` +
        `<transcluded-doc id="${P}-never-existed" missing="true"/>`
    );
    expect(read.content).not.toContain('<!--');
    expect(read.transclusions).toEqual([
      { id: gone, title: 'Gone', archived: true },
      { id: `${P}-never-existed`, missing: true },
    ]);
  });

  it('escapes titles and leaves a literal closing tag as the transcluded doc’s text', async () => {
    const a = id('a');
    const b = id('b');
    await seed(b, 'Q"></transcluded-doc>', 'one\n</transcluded-doc>\ntwo');
    await seed(a, 'A', `![](${b})`);
    const read = await ok<DocRead & { warnings?: string[] }>({ op: 'get', id: a });
    expect(read.content).toBe(
      `<transcluded-doc id="${b}" title="Q&quot;&gt;&lt;/transcluded-doc&gt;">\n` +
        'one\n</transcluded-doc>\ntwo\n</transcluded-doc>'
    );
    expect(read.warnings).toEqual([
      `"Q"></transcluded-doc>" (${b}) contains text that looks like a <transcluded-doc> tag; it is that doc's own text, not a transclusion.`,
    ]);
  });

  it('renders a loop already in stored data as a marker', async () => {
    const a = id('a');
    const b = id('b');
    await seed(a, 'A', 'a');
    await seed(b, 'B', 'b');
    await store(a, `a ![](${b})`);
    await store(b, `b ![](${a})`);
    const read = await ok<DocRead>({ op: 'get', id: a });
    expect(read.content).toBe(
      `a <transcluded-doc id="${b}" title="B">\n` +
        `b <transcluded-doc id="${a}" title="A" skipped="loop"/>\n</transcluded-doc>`
    );
  });

  it('reads a part link from the stored source, transclusions unexpanded', async () => {
    const a = id('a');
    const b = id('b');
    await seed(b, 'B', 'b body');
    await seed(a, 'A', `line one\n![](${b})\nline three`);
    const read = await ok<DocRead>({ op: 'get', id: `${a}#L2-L3` });
    expect(read.content).toBe(`![](${b})\nline three`);
    expect(read.lines).toMatchObject({ start_line: 2, end_line: 3 });
  });
});

interface EditResult {
  doc_id: string;
  edits_applied: Array<{ index: number; doc_id: string; applied_at: number }>;
  edited_docs: Array<{ id: string; title: string; transcluded_in: number; backup_id?: string }>;
  message?: string;
  preview?: Array<{ doc_id: string; old_content: string; new_content: string }>;
}

/** A parent transcluding a shared doc that one other doc also transcludes. */
async function contract() {
  const a = id('a');
  const b = id('b');
  const other = id('other');
  await seed(b, 'Terms', 'Pay within 30 days.\nLate fees apply.');
  await seed(a, 'Contract', `Intro text.\n![Terms](${b})\nSigned by both.`);
  await seed(other, 'Invoice', `![](${b})`);
  return { a, b, other };
}

describe('doc update: edits go to the doc that owns the text', () => {
  it('edits the parent when the text is its own', async () => {
    const { a, b } = await contract();
    const out = await ok<EditResult>({
      op: 'update',
      id: a,
      edits: [{ old_text: 'Signed by both.', new_text: 'Signed.' }],
    });
    expect(out.edits_applied[0]).toMatchObject({ doc_id: a });
    expect(out.edited_docs.map((d) => d.id)).toEqual([a]);
    expect(out).not.toHaveProperty('message');
    expect(await contentOf(a)).toBe(`Intro text.\n![Terms](${b})\nSigned.`);
    expect(await contentOf(b)).toBe('Pay within 30 days.\nLate fees apply.');
  });

  it('edits the transcluded doc, with its own backup and attribution, and says so', async () => {
    const { a, b } = await contract();
    const parentBefore = await contentOf(a);
    const out = await ok<EditResult>({
      op: 'update',
      id: a,
      edits: [{ old_text: '30 days', new_text: '45 days' }],
    });
    expect(out.edits_applied).toEqual([
      expect.objectContaining({ index: 0, doc_id: b, applied_at: 'Pay within '.length }),
    ]);
    expect(out.edited_docs).toEqual([
      expect.objectContaining({ id: b, title: 'Terms', transcluded_in: 2 }),
    ]);
    expect(out.message).toContain(`changed "Terms" (${b}), not "Contract"`);
    expect(out.message).toContain('transcluded in at least 2 docs');
    expect(await contentOf(b)).toBe('Pay within 45 days.\nLate fees apply.');
    expect(await contentOf(a)).toBe(parentBefore);
    expect(await snapshotsOf(b)).toEqual(['Pay within 30 days.\nLate fees apply.']);
    expect(await snapshotsOf(a)).toEqual([]);
    expect((await Docs.findById(b))?.lastEditedBy).toBe(agentMember);
  });

  it('routes a nested match to the right owner', async () => {
    const a = id('a');
    const b = id('b');
    const c = id('c');
    await seed(c, 'Deep', 'deep words');
    await seed(b, 'Middle', `middle\n![](${c})`);
    await seed(a, 'Top', `top\n![](${b})`);
    const out = await ok<EditResult>({
      op: 'update',
      id: a,
      edits: [
        { old_text: 'deep words', new_text: 'deeper words' },
        { old_text: 'middle', new_text: 'center' },
      ],
    });
    expect(out.edits_applied.map((e) => e.doc_id)).toEqual([c, b]);
    expect(await contentOf(c)).toBe('deeper words');
    expect(await contentOf(b)).toBe(`center\n![](${c})`);
  });

  it('refuses a match that runs from the parent into a transcluded doc', async () => {
    const { a, b } = await contract();
    const error = await refused({
      op: 'update',
      id: a,
      edits: [{ old_text: 'Late fees apply.\n</transcluded-doc>\nSigned', new_text: 'x' }],
    });
    expect(error).toContain('<transcluded-doc> tag');
    expect(error).toContain(b);
    expect(error).toContain('raw: true');
    expect(await contentOf(b)).toBe('Pay within 30 days.\nLate fees apply.');
  });

  it('refuses a match spanning two transcluded docs side by side', async () => {
    const a = id('a');
    const b = id('b');
    const c = id('c');
    await seed(b, 'Left', 'left end');
    await seed(c, 'Right', 'right start');
    await seed(a, 'Both', `![](${b})![](${c})`);
    await store(a, `![](${b})![](${c})`);
    const error = await refused({
      op: 'update',
      id: a,
      edits: [{ old_text: `left end\n</transcluded-doc><transcluded-doc id="${c}"`, new_text: '' }],
    });
    expect(error).toContain('Edit each doc separately');
  });

  it('refuses an edit to a wrapper line', async () => {
    const { a, b } = await contract();
    const error = await refused({
      op: 'update',
      id: a,
      edits: [{ old_text: `<transcluded-doc id="${b}" title="Terms">`, new_text: '' }],
    });
    expect(error).toContain('<transcluded-doc> tag');
    expect(await contentOf(a)).toContain(`![Terms](${b})`);
  });

  it('refuses text in an archived transcluded doc and edits nothing', async () => {
    const { a, b } = await contract();
    await archive(b);
    const error = await refused({
      op: 'update',
      id: a,
      edits: [{ old_text: 'Late fees apply.', new_text: 'No late fees.' }],
    });
    expect(error).toContain('archived');
    expect(error).toContain(b);
    expect(await contentOf(b)).toBe('Pay within 30 days.\nLate fees apply.');
    expect(await contentOf(a)).toContain('Intro text.');
  });

  it('changes a transclusion line through the stored source', async () => {
    const { a, b } = await contract();
    const c = id('c');
    await seed(c, 'New terms', 'Due on receipt.');
    const out = await ok<EditResult>({
      op: 'update',
      id: a,
      edits: [{ old_text: `![Terms](${b})`, new_text: `![New terms](${c})` }],
    });
    expect(out.edits_applied[0]).toMatchObject({ doc_id: a });
    expect(await contentOf(a)).toBe(`Intro text.\n![New terms](${c})\nSigned by both.`);
    const raw = await ok<EditResult>({
      op: 'update',
      id: a,
      raw: true,
      edits: [{ old_text: `\n![New terms](${c})`, new_text: '' }],
    });
    expect(raw.edits_applied[0]).toMatchObject({ doc_id: a });
    expect(await contentOf(a)).toBe('Intro text.\nSigned by both.');
  });

  it('keeps a multi-doc batch atomic: one bad edit writes nothing', async () => {
    const { a, b } = await contract();
    const error = await refused({
      op: 'update',
      id: a,
      edits: [
        { old_text: '30 days', new_text: '45 days' },
        { old_text: 'Signed by both.', new_text: 'Signed.' },
        { old_text: 'not in any doc', new_text: 'x' },
      ],
    });
    expect(error).toContain('Edit 2: text not found');
    expect(await contentOf(b)).toBe('Pay within 30 days.\nLate fees apply.');
    expect(await contentOf(a)).toContain('Signed by both.');
  });

  it('validate_only reports the same routing and writes nothing', async () => {
    const { a, b } = await contract();
    const out = await ok<EditResult>({
      op: 'update',
      id: a,
      validate_only: true,
      edits: [
        { old_text: '30 days', new_text: '45 days' },
        { old_text: 'Intro text.', new_text: 'Preamble.' },
      ],
    });
    expect(out.edits_applied.map((e) => e.doc_id)).toEqual([b, a]);
    expect(out.message).toContain(`changed "Terms" (${b})`);
    expect(out.preview).toEqual([
      expect.objectContaining({ doc_id: b, new_content: 'Pay within 45 days.\nLate fees apply.' }),
      expect.objectContaining({ doc_id: a, new_content: expect.stringContaining('Preamble.') }),
    ]);
    expect(await contentOf(b)).toBe('Pay within 30 days.\nLate fees apply.');
    expect(await contentOf(a)).toContain('Intro text.');
  });

  it('counts a doc shown twice as one place, numbering matches as read', async () => {
    const a = id('a');
    const b = id('b');
    await seed(b, 'Shared', 'shared line');
    await seed(a, 'Twice', `![](${b})\n![](${b})\nshared line`);
    const error = await refused({
      op: 'update',
      id: a,
      edits: [{ old_text: 'shared line', new_text: 'x' }],
    });
    expect(error).toContain('ambiguous (3 matches, 2 places)');
    expect(error).toContain(`occurrence 2 in "Shared" (${b}), the same text as occurrence 1`);
    const out = await ok<EditResult>({
      op: 'update',
      id: a,
      edits: [{ old_text: 'shared line', new_text: 'changed line', occurrence: 2 }],
    });
    expect(out.edits_applied[0]).toMatchObject({ doc_id: b });
    expect(await contentOf(b)).toBe('changed line');
    const all = await ok<EditResult>({
      op: 'update',
      id: a,
      edits: [{ old_text: 'changed line', new_text: 'line', occurrence: -1 }],
    });
    expect(all.edits_applied.map((e) => e.doc_id)).toEqual([b]);
    expect(await contentOf(b)).toBe('line');
  });
});

describe('loops are refused on save', () => {
  it('refuses a doc transcluding itself', async () => {
    const a = id('a');
    await seed(a, 'Alpha', 'alpha');
    const error = await refused({
      op: 'update',
      id: a,
      edits: [{ old_text: 'alpha', new_text: `alpha ![](${a})` }],
    });
    expect(error).toContain(`Transclusion loop: "Alpha" (${a}) → "Alpha" (${a})`);
    expect(await contentOf(a)).toBe('alpha');
  });

  it('refuses A ↔ B and A → B → C → A, naming the chain', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id);
    await seed(a, 'A', 'a');
    await seed(b, 'B', `![](${a})`);
    const pair = await refused({
      op: 'update',
      id: a,
      edits: [{ old_text: 'a', new_text: `![](${b})` }],
    });
    expect(pair).toContain(`"A" (${a}) → "B" (${b}) → "A" (${a})`);

    await seed(c, 'C', `![](${a})`);
    await store(b, `![](${c})`);
    const chain = await refused({
      op: 'update',
      id: a,
      edits: [{ old_text: 'a', new_text: `![](${b})` }],
    });
    expect(chain).toContain(`"A" (${a}) → "B" (${b}) → "C" (${c}) → "A" (${a})`);
    expect(await contentOf(a)).toBe('a');
  });

  it('refuses a loop closed inside a transcluded doc and rolls the whole batch back', async () => {
    const { a, b } = await contract();
    const error = await refused({
      op: 'update',
      id: a,
      edits: [
        { old_text: 'Intro text.', new_text: 'Preamble.' },
        { old_text: 'Late fees apply.', new_text: `Late fees apply.\n![](${a})` },
      ],
    });
    expect(error).toContain(`"Terms" (${b}) → "Contract" (${a}) → "Terms" (${b})`);
    expect(await contentOf(a)).toContain('Intro text.');
    expect(await contentOf(b)).toBe('Pay within 30 days.\nLate fees apply.');
    expect(await snapshotsOf(a)).toEqual([]);
  });

  it('refuses a loop in validate_only too', async () => {
    const { a } = await contract();
    const error = await refused({
      op: 'update',
      id: a,
      validate_only: true,
      edits: [{ old_text: 'Late fees apply.', new_text: `![](${a})` }],
    });
    expect(error).toContain('Transclusion loop');
  });

  it('refuses a create that closes a loop (the model write the tool uses)', async () => {
    const a = id('a');
    const b = id('b');
    await seed(b, 'B', `![](${a})`);
    await expect(Docs.create({ id: a, title: 'A', content: `![](${b})` })).rejects.toThrow(
      `"A" (${a}) → "B" (${b}) → "A" (${a})`
    );
    expect(await Docs.findById(a)).toBeNull();
  });

  it('refuses a duplicate whose copy would transclude itself', async () => {
    const a = id('a');
    await seed(a, 'Self', 'self');
    await store(a, `self ![](${a})`);
    const error = await refused({ op: 'duplicate', id: a, new_title: 'Self copy' });
    expect(error).toContain('Transclusion loop');
    expect(await Docs.listByContainer(null)).not.toContainEqual(
      expect.objectContaining({ title: 'Self copy' })
    );
  });

  it('refuses a restore that would bring a loop back', async () => {
    const a = id('a');
    const b = id('b');
    await seed(b, 'B', 'b');
    await seed(a, 'A', `![](${b})`);
    await ok({ op: 'snapshot', id: a, label: 'with b' });
    const [snap] = (
      await getDb().query<{ id: string }>(`SELECT id FROM doc_snapshots WHERE doc_id = $1`, [a])
    ).rows;
    await ok({ op: 'update', id: a, raw: true, edits: [{ old_text: `![](${b})`, new_text: 'a' }] });
    await ok({ op: 'update', id: b, edits: [{ old_text: 'b', new_text: `![](${a})` }] });
    const error = await refused({ op: 'restore', id: a, snapshot_id: snap!.id });
    expect(error).toContain(`"A" (${a}) → "B" (${b}) → "A" (${a})`);
    expect(await contentOf(a)).toBe('a');
  });

  it('refuses a REST save that closes a loop, with the chain in the error', async () => {
    const a = id('a');
    const b = id('b');
    await seed(a, 'A', 'a');
    await seed(b, 'B', `![](${a})`);
    const res = await request(app)
      .patch(`/api/docs/${a}`)
      .send({ content: `a\n![](${b})` })
      .expect(409);
    expect(res.body.error.message).toContain(`"A" (${a}) → "B" (${b}) → "A" (${a})`);
    expect(res.body.error.details.transclusionLoop.map((s: { id: string }) => s.id)).toEqual([
      a,
      b,
      a,
    ]);
    expect(await contentOf(a)).toBe('a');
  });

  it('refuses a REST move that also saves a looping body, before the move lands', async () => {
    const a = id('a');
    const b = id('b');
    const folder = `${P}-move-${(seq += 1)}`;
    await Containers.create({ id: folder, name: `Move target ${seq}` });
    await seed(a, 'A', 'a');
    await seed(b, 'B', `![](${a})`);
    await request(app)
      .patch(`/api/docs/${a}`)
      .send({ containerId: folder, content: `![](${b})` })
      .expect(409);
    const after = await Docs.findById(a);
    expect(after?.containerId).toBeNull();
    expect(after?.content).toBe('a');
  });

  it('refuses a looping restore in validate_only and over REST, writing no snapshot', async () => {
    const a = id('a');
    const b = id('b');
    await seed(b, 'B', 'b');
    await seed(a, 'A', `![](${b})`);
    await ok({ op: 'snapshot', id: a, label: 'with b' });
    const [snap] = (
      await getDb().query<{ id: string }>(`SELECT id FROM doc_snapshots WHERE doc_id = $1`, [a])
    ).rows;
    await ok({ op: 'update', id: a, raw: true, edits: [{ old_text: `![](${b})`, new_text: 'a' }] });
    await ok({ op: 'update', id: b, edits: [{ old_text: 'b', new_text: `![](${a})` }] });
    const before = await snapshotsOf(a);

    const preview = await refused({
      op: 'restore',
      id: a,
      snapshot_id: snap!.id,
      validate_only: true,
    });
    expect(preview).toContain('Transclusion loop');
    await refused({ op: 'restore', id: a, snapshot_id: snap!.id });
    const res = await request(app).post(`/api/docs/${a}/snapshots/${snap!.id}/restore`).expect(409);
    expect(res.body.error.message).toContain('Transclusion loop');
    expect(await snapshotsOf(a)).toEqual(before);
    expect(await contentOf(a)).toBe('a');
  });

  it('answers the editor’s loop check before it transcludes', async () => {
    const a = id('a');
    const b = id('b');
    const c = id('c');
    await seed(a, 'A', 'a');
    await seed(b, 'B', `![](${a})`);
    await seed(c, 'C', 'c');
    const looped = await request(app)
      .get(`/api/docs/${a}/transclusion-loop`)
      .query({ target: b })
      .expect(200);
    expect(looped.body.data.loop.map((s: { title: string }) => s.title)).toEqual(['A', 'B', 'A']);
    const fine = await request(app)
      .get(`/api/docs/${a}/transclusion-loop`)
      .query({ target: c })
      .expect(200);
    expect(fine.body.data.loop).toBeNull();
  });

  it('refuses a clone of docs that already loop', async () => {
    const folder = `${P}-folder-${(seq += 1)}`;
    await Containers.create({ id: folder, name: `Loop folder ${seq}` });
    const a = id('a');
    const b = id('b');
    await Docs.create({ id: a, title: 'A', content: 'a', containerId: folder });
    await Docs.create({ id: b, title: 'B', content: 'b', containerId: folder });
    await store(a, `![](${b})`);
    await store(b, `![](${a})`);
    await expect(cloneNode({ sourceId: folder, targetContainerId: null })).rejects.toThrow(
      'Transclusion loop'
    );
    const { rows } = await getDb().query(
      `SELECT id FROM containers WHERE name LIKE 'Loop folder%'`
    );
    expect(rows).toHaveLength(1);
  });

  it('lets a loop already in stored data be edited elsewhere', async () => {
    const a = id('a');
    const b = id('b');
    await seed(a, 'A', 'a');
    await seed(b, 'B', 'b');
    await store(a, `a text\n![](${b})`);
    await store(b, `![](${a})`);
    await ok({
      op: 'update',
      id: a,
      raw: true,
      edits: [{ old_text: 'a text', new_text: 'a words' }],
    });
    await request(app)
      .patch(`/api/docs/${a}`)
      .send({ content: `a words, again\n![](${b})` })
      .expect(200);
    expect(await contentOf(a)).toBe(`a words, again\n![](${b})`);
  });
});

describe('doc delete: protected while transcluded', () => {
  it('refuses, lists the transcluding docs on dry_run, and deletes with force', async () => {
    const { b, a, other } = await contract();
    const error = await refused({ op: 'delete', id: b });
    expect(error).toContain(
      `Refusing to delete "Terms" (${b}): of the other docs, 2 transclude it`
    );
    expect(error).toContain(`"Contract" (${a})`);

    const dry = await ok<{ deleted: boolean; transcluded_in: Array<{ id: string }> }>({
      op: 'delete',
      id: b,
      dry_run: true,
      force: true,
    });
    expect(dry.deleted).toBe(false);
    expect(dry.transcluded_in.map((d) => d.id).sort()).toEqual([a, other].sort());

    await ok({ op: 'delete', id: b, force: true });
    const read = await ok<DocRead>({ op: 'get', id: a });
    expect(read.content).toContain(`<transcluded-doc id="${b}" missing="true"/>`);
  });

  it('is blocked by links too, a part link included, and says which only link', async () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id);
    await seed(b, 'B', '## Setup\nsteps');
    await seed(a, 'A', `see [B](${b}#h=setup)`);
    await seed(c, 'C', `![B](${b})`);
    await seed(d, 'D', `old notes on [B](${b})`);
    await archive(d);
    const error = await refused({ op: 'delete', id: b });
    expect(error).toContain(
      `of the other docs, 1 transclude it ("C" (${c})) and 2 only link to it ("A" (${a}), "D" (${d}) [archived])`
    );
    const dry = await ok<{ transcluded_in: unknown[]; linked_from: unknown[] }>({
      op: 'delete',
      id: b,
      dry_run: true,
      force: true,
    });
    expect(dry.transcluded_in).toEqual([{ id: c, title: 'C' }]);
    expect(dry.linked_from).toEqual([
      { id: a, title: 'A' },
      { id: d, title: 'D', archived: true },
    ]);
    await ok({ op: 'delete', id: b, force: true });
    expect(await Docs.findById(b)).toBeNull();
  });

  it('still finds who refers to an archived doc, whose links archiving dropped', async () => {
    const [a, b] = ['a', 'b'].map(id);
    await seed(b, 'B', 'b');
    await seed(a, 'A', `![B](${b})`);
    await archive(b);
    const error = await refused({ op: 'delete', id: b });
    expect(error).toContain(`1 transclude it ("A" (${a}))`);
  });

  it('refuses after the doc was archived and restored, which drops links into it', async () => {
    const [a, b] = ['a', 'b'].map(id);
    await seed(b, 'B', 'b');
    await seed(a, 'A', `see [B](${b})`);
    await archive(b);
    await getDb().query(`UPDATE nodes SET archived = false, archived_at = NULL WHERE id = $1`, [b]);
    const { rows } = await getDb().query(`SELECT 1 FROM links WHERE target_id = $1`, [b]);
    expect(rows).toHaveLength(0);
    const error = await refused({ op: 'delete', id: b });
    expect(error).toContain(`1 only link to it ("A" (${a}))`);
  });

  it('refuses for a link whose label has escaped brackets, as the editor writes them', async () => {
    const [a, b] = ['a', 'b'].map(id);
    await seed(b, '[WIP] Plan', 'b');
    await seed(a, 'A', `see [\\[WIP\\] Plan](${b})`);
    const error = await refused({ op: 'delete', id: b });
    expect(error).toContain(`1 only link to it ("A" (${a}))`);
  });

  it('is not blocked by a reference that only appears inside code', async () => {
    const [a, b] = ['a', 'b'].map(id);
    await seed(b, 'B', 'b');
    await seed(a, 'A', `Syntax:\n\n\`\`\`md\n![B](${b})\n[B](${b})\n\`\`\``);
    await ok({ op: 'delete', id: b });
    expect(await Docs.findById(b)).toBeNull();
  });

  it('deletes a doc nothing refers to', async () => {
    const b = id('b');
    await seed(b, 'B', 'b');
    await ok({ op: 'delete', id: b });
    expect(await Docs.findById(b)).toBeNull();
  });
});

describe('list_inline_refs does not exist', () => {
  it('has no handler, definition or alias', async () => {
    expect(toolRegistry.hasHandler('list_inline_refs')).toBe(false);
    expect(toolRegistry.getDefinition('list_inline_refs')).toBeUndefined();
    const result = await runWithActor(ACTOR, () =>
      toolExecutor.execute({ name: 'workspace_list_inline_refs', input: {} }, agentTool)
    );
    expect(result.success).toBe(false);
  });
});

describe('doc update: text changed between read and write', () => {
  const realLoader = jest.requireActual<typeof transclusionGraph>(
    '@server/services/transclusions/transclusionGraph'
  ).cachedDocLoader;

  /** Run `change` right after the edit reads `docId`, as a racing save would. */
  function raceAfterRead(docId: string, change: () => Promise<void>) {
    let done = false;
    return jest.spyOn(transclusionGraph, 'cachedDocLoader').mockImplementation((runner) => {
      const load = realLoader(runner);
      return async (ids) => {
        const found = await load(ids);
        if (!done && ids.includes(docId)) {
          done = true;
          await change();
        }
        return found;
      };
    });
  }

  it.each([
    [
      'changed',
      (b: string) => store(b, 'Pay within 30 days.\nLate fees apply. Typed by a person.'),
    ],
    ['was archived', (b: string) => archive(b)],
    [
      'was deleted',
      async (b: string) => {
        await getDb().query(`DELETE FROM nodes WHERE id = $1`, [b]);
      },
    ],
  ])('refuses to write a doc that %s, and saves nothing', async (what, change) => {
    const { a, b } = await contract();
    const spy = raceAfterRead(b, () => change(b));
    try {
      const error = await refused({
        op: 'update',
        id: a,
        edits: [
          { old_text: 'Intro text.', new_text: 'Preamble.' },
          { old_text: '30 days', new_text: '45 days' },
        ],
      });
      expect(error).toContain(`"Terms" (${b}) ${what} since this edit read it`);
      expect(error).toContain('read it again and retry');
    } finally {
      spy.mockRestore();
    }
    expect(await contentOf(a)).toContain('Intro text.');
    if (what === 'changed') expect(await contentOf(b)).toContain('Typed by a person.');
  });
});

describe('doc update: parts a batch breaks', () => {
  async function guide() {
    const [a, b, c] = ['a', 'b', 'c'].map(id);
    await seed(b, 'Guide', '# Guide\n\npre text\n\n## Setup\n\ninstall it\n\n## Other\n\nmore');
    await seed(a, 'Host', `intro\n![Setup](${b}#h=setup)\nout`);
    await seed(c, 'Elsewhere', `![](${b}#h=setup)`);
    return { a, b, c };
  }

  it('warns for every doc whose part transclusion a heading rename breaks', async () => {
    const { a, b, c } = await guide();
    const out = await ok<EditResult & { warnings: Array<{ doc_id: string; message: string }> }>({
      op: 'update',
      id: a,
      edits: [{ old_text: '## Setup', new_text: '## Install' }],
    });
    expect(out.edits_applied[0]).toMatchObject({ doc_id: b });
    const broken = out.warnings.filter((w) => w.message.includes('now shows as missing'));
    expect(broken.map((w) => w.doc_id).sort()).toEqual([a, c].sort());
    expect(broken[0]!.message).toContain(`the "h=setup" part of "Guide" (${b})`);
  });

  it('warns for the doc edited through even when the links graph misses it', async () => {
    const [a, b] = ['a', 'b'].map(id);
    await seed(b, 'Guide', '# Guide\n\n## Setup\n\ninstall it');
    await seed(a, 'Host', `intro\n![\\[WIP\\] Setup](${b}#h=setup)\nout`);
    const { rows } = await getDb().query(`SELECT 1 FROM links WHERE source_id = $1`, [a]);
    expect(rows).toHaveLength(0);
    const out = await ok<EditResult & { warnings: Array<{ doc_id: string; message: string }> }>({
      op: 'update',
      id: a,
      edits: [{ old_text: '## Setup', new_text: '## Install' }],
    });
    expect(out.warnings.filter((w) => w.message.includes('now shows as missing'))).toEqual([
      expect.objectContaining({ doc_id: a }),
    ]);
    expect(out.edited_docs).toEqual([expect.objectContaining({ id: b, transcluded_in: 1 })]);
  });

  it('says why text is not found after an earlier edit hid it', async () => {
    const { a, b } = await guide();
    const error = await refused({
      op: 'update',
      id: a,
      edits: [
        { old_text: '## Setup', new_text: '## Install' },
        { old_text: 'install it', new_text: 'X' },
      ],
    });
    expect(error).toContain(
      `Edit 1: text not found in what this doc shows. "Guide" (${b}) has it, but this doc shows only its "h=setup" part, which no longer exists after an earlier edit in this batch`
    );
    expect(await contentOf(b)).toContain('## Setup');
  });

  it('says when the text is in the transcluded doc but outside the part shown', async () => {
    const { a, b } = await guide();
    const error = await refused({
      op: 'update',
      id: a,
      edits: [{ old_text: 'pre text', new_text: 'X' }],
    });
    expect(error).toContain(
      `"Guide" (${b}) has it, but this doc shows only its "h=setup" part, and the text is outside it`
    );
  });
});

describe('doc get: transcluded_in cost', () => {
  it('lists the first 20 docs by title with the total, and skips the list on part reads', async () => {
    const b = id('b');
    await seed(b, 'Shared', '## Part\nshared');
    for (let n = 0; n < 22; n++) {
      await seed(id('host'), `Host ${String(n).padStart(2, '0')}`, `![](${b})`);
    }
    const read = await ok<DocRead & { transcluded_in_total?: number }>({ op: 'get', id: b });
    expect(read.transcluded_in).toHaveLength(20);
    expect(read.transcluded_in![0]!.title).toBe('Host 00');
    expect(read.transcluded_in_total).toBe(22);

    const part = await ok<DocRead>({ op: 'get', id: `${b}#h=part` });
    expect(part.content).toBe('## Part\nshared');
    expect(part).not.toHaveProperty('transcluded_in');
  });
});

describe('doc update: an archive racing the write', () => {
  it('waits for an archive that holds the doc, then refuses instead of writing to it', async () => {
    const { a, b } = await contract();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    // Another connection archives B and keeps its transaction open.
    const archiving = (await getDbClient()).transaction(async (tx) => {
      await tx.query(`UPDATE nodes SET archived = true, archived_at = now() WHERE id = $1`, [b]);
      locked();
      await held;
    });
    await isLocked;
    const edit = run({
      op: 'update',
      id: a,
      edits: [{ old_text: '30 days', new_text: '45 days' }],
    });
    // The edit is now waiting on B's node row; let the archive commit.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await archiving;
    const result = await edit;
    expect(result.success).toBe(false);
    expect(result.error).toContain(`"Terms" (${b}) was archived since this edit read it`);
    expect(await contentOf(b)).toBe('Pay within 30 days.\nLate fees apply.');
  });
});
