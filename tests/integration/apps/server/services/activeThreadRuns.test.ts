/**
 * End-to-end (real managed PostgreSQL) check for the active-thread run markers.
 *
 * Proves the batched `runs ⋈ agents` SQL and the ActiveRunTracker gating work
 * together across two layers:
 *   - thread-level: a thread is marked only while a session holds its run lock;
 *     a running DB row with no live session (stale/dead-process) is not active.
 *   - run-level: on a live thread, only the run id the tracker still considers
 *     in-flight is named — a stale sibling `status='running'` row from a
 *     crashed/reaped prior agent must not leak its name into the marker.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { getDb } from '@snaglet/db';
import { randomUUID } from 'crypto';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { activeRunMarker, getThreadActivity } from '@server/services/activeThreadRuns';

describe('getThreadActivity — real DB', () => {
  const agentId = `agent-${randomUUID()}`;
  const staleAgentId = `agent-${randomUUID()}`;
  const liveThreadId = `thread-${randomUUID()}`;
  const staleThreadId = `thread-${randomUUID()}`;
  const sessionId = `session-${randomUUID()}`;
  const liveRunId = `run-${randomUUID()}`;
  // A second `running` row on the live thread from a crashed prior agent whose
  // status never flipped — the tracker does not consider it in-flight.
  const staleSiblingRunId = `run-${randomUUID()}`;

  beforeAll(async () => {
    const pool = getDb();
    await pool.query(`INSERT INTO agents (id, name, role, system_prompt) VALUES ($1,$2,$3,$4)`, [
      agentId,
      'Clio_ActiveRunMarker',
      'Test Role',
      'Test prompt',
    ]);
    await pool.query(`INSERT INTO agents (id, name, role, system_prompt) VALUES ($1,$2,$3,$4)`, [
      staleAgentId,
      'Venus_StaleSibling',
      'Test Role',
      'Test prompt',
    ]);
    for (const threadId of [liveThreadId, staleThreadId]) {
      await pool.query(`INSERT INTO nodes (id, type) VALUES ($1,'thread')`, [threadId]);
      await pool.query(`INSERT INTO threads (id, title) VALUES ($1,$2)`, [threadId, 'T']);
    }
    // Live thread: the in-flight run (liveRunId → Clio) plus a stale sibling
    // running row (staleSiblingRunId → Venus) that must not be named.
    await pool.query(
      `INSERT INTO runs (id, agent_id, thread_id, status, model, provider_id, started_at)
       VALUES ($1,$2,$3,'running','m','openai',NOW())`,
      [liveRunId, agentId, liveThreadId]
    );
    await pool.query(
      `INSERT INTO runs (id, agent_id, thread_id, status, model, provider_id, started_at)
       VALUES ($1,$2,$3,'running','m','openai',NOW())`,
      [staleSiblingRunId, staleAgentId, liveThreadId]
    );
    // Stale thread: a running row with no live session at all.
    await pool.query(
      `INSERT INTO runs (id, agent_id, thread_id, status, model, provider_id, started_at)
       VALUES ($1,$2,$3,'running','m','openai',NOW())`,
      [`run-${randomUUID()}`, agentId, staleThreadId]
    );
  });

  afterAll(async () => {
    const pool = getDb();
    activeRunTracker.finish(liveRunId);
    activeRunTracker.finishSession(sessionId);
    await pool.query(`DELETE FROM runs WHERE agent_id = ANY($1::text[])`, [
      [agentId, staleAgentId],
    ]);
    await pool.query(`DELETE FROM threads WHERE id = ANY($1::text[])`, [
      [liveThreadId, staleThreadId],
    ]);
    await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[agentId, staleAgentId]]);
    await pool.query(`DELETE FROM nodes WHERE id = ANY($1::text[])`, [
      [liveThreadId, staleThreadId],
    ]);
  });

  it('names only the live run on a live thread — not a stale sibling or a stale thread', async () => {
    // Live thread holds a run lock and its in-flight run is registered; the
    // stale sibling run is intentionally not registered with the tracker.
    activeRunTracker.startSession(sessionId, liveThreadId);
    activeRunTracker.start(liveRunId);

    const activity = await getThreadActivity([liveThreadId, staleThreadId]);

    // Only Clio (the in-flight run) is named — Venus's stale sibling row is dropped.
    expect(activity.get(liveThreadId)).toEqual({ agentNames: ['Clio_ActiveRunMarker'] });
    expect(activeRunMarker(activity.get(liveThreadId))).toBe('▶ running (Clio_ActiveRunMarker)');
    // Stale thread: DB says status='running' but no live session — must not be active.
    expect(activity.has(staleThreadId)).toBe(false);
    expect(activeRunMarker(activity.get(staleThreadId))).toBe('');
  });
});
