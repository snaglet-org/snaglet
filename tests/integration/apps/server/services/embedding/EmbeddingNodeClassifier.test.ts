/**
 * EmbeddingNodeClassifier — 'message' case against the real database.
 *
 * thread_event rows (role='user', message_type='thread_event': author-less
 * narration of thread-variable state, see MessageModel.createEvent) stay out of
 * the embedding index although their role is 'user':
 * `listNodeIdsForType('message')` (via `listEmbeddingTargets`) excludes
 * thread_event and injected rows and keeps authored messages and questions.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, Messages, Threads, Users } from '@snaglet/db';
import { removeAllIneligibleMessageEmbeddings } from '@server/services/embedding/injectedMessageCleanup';
import { Nodes } from '@snaglet/db/tables/nodes';
import {
  listEmbeddingTargets,
  buildEmbeddingTarget,
} from '@server/services/embedding/EmbeddingNodeClassifier';

const PREFIX = 'msg-classifier-msgtype-test';
const THREAD_ID = `thread-${PREFIX}`;
const NORMAL_ID = `message-${PREFIX}-normal`;
const EVENT_ID = `message-${PREFIX}-event`;
const QUESTION_ID = `message-${PREFIX}-question`;
const INJECTED_ID = `message-${PREFIX}-injected`;

const ERROR_ID = `message-${PREFIX}-error`;
const ABORT_ID = `message-${PREFIX}-abort`;

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM public.messages WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.threads WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.nodes WHERE id = $1 OR id LIKE $2`, [
    THREAD_ID,
    `message-${PREFIX}-%`,
  ]);
}

describe("EmbeddingNodeClassifier 'message' case — message_type filter", () => {
  beforeAll(async () => {
    await cleanup();
    await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
    const user = await Users.getOrCreateLocalUser();
    await Messages.create({
      id: ERROR_ID,
      threadId: THREAD_ID,
      role: 'user',
      userId: user.id,
      content: 'Run timed out.',
      injectedDuringRun: true,
      metadata: { run_error: { kind: 'timeout' } },
    });
    await Messages.createEvent({
      id: ABORT_ID,
      threadId: THREAD_ID,
      content: '[Operator] aborted [Worker]',
      eventKind: 'agent_run_aborted',
    });
    await Messages.create({
      id: INJECTED_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'A real mid-run message is excluded by explicit product policy.',
      userId: user.id,
      injectedDuringRun: true,
    });

    // A real, embeddable user message (message_type defaults to 'message').
    await Messages.create({
      id: NORMAL_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: `real user content ${PREFIX}`,
      agentId: null,
      userId: user.id,
    });

    // An author-less thread_event row: role='user', message_type='thread_event'.
    await Messages.createEvent({
      id: EVENT_ID,
      threadId: THREAD_ID,
      content: `[thread started · participants: (none yet) · mode: all]`,
      eventKind: 'thread_started',
    });

    // A real message the heuristic tagged as a clarifying question
    // (message_type='question') — genuine conversational content, so it must
    // stay embeddable (only machine rows like thread_event are excluded).
    await Messages.create({
      id: QUESTION_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: `should we proceed ${PREFIX}?`,
      agentId: null,
      userId: user.id,
      messageType: 'question',
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  it('includes message + question rows and excludes thread_event rows', async () => {
    const targets = await listEmbeddingTargets(['message']);
    const ids = targets.map((t) => t.nodeId);
    expect(ids).toContain(NORMAL_ID);
    expect(ids).toContain(QUESTION_ID);
    expect(ids).toContain(ERROR_ID);
    expect(ids).toContain(ABORT_ID);
    expect(ids).not.toContain(EVENT_ID);
    expect(ids).not.toContain(INJECTED_ID);
  });
  it('also excludes injected rows and events from direct target construction', async () => {
    expect(await buildEmbeddingTarget('message', INJECTED_ID)).toBeNull();
    expect(await buildEmbeddingTarget('message', EVENT_ID)).toBeNull();
    expect(await buildEmbeddingTarget('message', NORMAL_ID)).not.toBeNull();
    expect(await buildEmbeddingTarget('message', ERROR_ID)).not.toBeNull();
    expect(await buildEmbeddingTarget('message', ABORT_ID)).not.toBeNull();
  });
  it('startup cleanup keeps error/abort and other-node vectors and is idempotent', async () => {
    const db = getDb();
    const model = `${PREFIX}-model`;
    const provider = `${PREFIX}-provider`;
    const doc = `doc-${PREFIX}`;
    await db.query(
      `INSERT INTO public.providers (id,name,type) VALUES ($1,'Test provider','runtime')`,
      [provider]
    );
    await db.query(
      `INSERT INTO public.models (id,provider_id,model_id,display_name,type,dimensions) VALUES ($1,$2,$1,'Test embedding','embedding',768)`,
      [model, provider]
    );
    await Nodes.ensure(doc, 'doc');
    const ids = [NORMAL_ID, QUESTION_ID, INJECTED_ID, EVENT_ID, ERROR_ID, ABORT_ID, doc];
    try {
      for (const id of ids) {
        await db.query(
          `INSERT INTO public.embeddings (id,node_id,model_id,vector,content_hash) VALUES ($1,$2,$3,$4::vector,'test')`,
          [`${id}-vector`, id, model, JSON.stringify(Array(768).fill(0.1))]
        );
      }
      expect(await removeAllIneligibleMessageEmbeddings()).toBe(2);
      const { rows } = await db.query(`SELECT node_id FROM public.embeddings WHERE model_id=$1`, [
        model,
      ]);
      expect(rows.map((r: { node_id: string }) => r.node_id).sort()).toEqual(
        [NORMAL_ID, QUESTION_ID, ERROR_ID, ABORT_ID, doc].sort()
      );
      expect(await removeAllIneligibleMessageEmbeddings()).toBe(0);
      const messages = await db.query(`SELECT id FROM public.messages WHERE thread_id=$1`, [
        THREAD_ID,
      ]);
      expect(messages.rows).toHaveLength(6);
    } finally {
      await db.query(`DELETE FROM public.embeddings WHERE model_id=$1`, [model]);
      await db.query(`DELETE FROM public.nodes WHERE id=$1`, [doc]);
      await db.query(`DELETE FROM public.models WHERE id=$1`, [model]);
      await db.query(`DELETE FROM public.providers WHERE id=$1`, [provider]);
    }
  });
});
