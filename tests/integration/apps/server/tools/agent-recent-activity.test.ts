/**
 * End-to-end tests for agent_recent_activity against the real database:
 * filters, error answers and output shape.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { getDb } from '@snaglet/db';
import handler from '@server/services/ToolService/handlers/agents/agentRecentActivity';
import { randomUUID } from 'crypto';

describe('agent_recent_activity end to end', () => {
  let testAgentId: string;
  let testRunId: string;
  let testThreadId: string;

  beforeAll(async () => {
    const pool = getDb();

    // Create a test agent. Agents are actors, not nodes —
    // the agents row stands alone, no public.nodes row.
    testAgentId = `agent-${randomUUID()}`;
    await pool.query(
      `INSERT INTO agents (id, name, role, system_prompt)
       VALUES ($1, $2, $3, $4)`,
      [testAgentId, 'TestAgent_ARA_v2', 'Test Role', 'Test prompt']
    );

    // Create a test thread (node must exist first)
    testThreadId = `thread-${randomUUID()}`;

    // Insert thread node (FK requirement)
    await pool.query(`INSERT INTO nodes (id, type) VALUES ($1, 'thread')`, [testThreadId]);

    await pool.query(`INSERT INTO threads (id, title) VALUES ($1, $2)`, [
      testThreadId,
      'Test Thread for agent_recent_activity v2',
    ]);

    // Create a test run
    testRunId = `run-${randomUUID()}`;
    await pool.query(
      `INSERT INTO runs (id, agent_id, thread_id, status, model, provider_id, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [testRunId, testAgentId, testThreadId, 'completed', 'test-model-1', 'openai']
    );

    // Insert test activity entries
    await pool.query(
      `INSERT INTO agent_activity_log 
       (agent_id, run_id, action_type, trigger_type, tool, tool_input, created_at)
       VALUES 
       ($1, $2, 'tool_call', 'manual', 'test_tool_1', '{"param": "value1"}', NOW() - INTERVAL '10 minutes'),
       ($1, $2, 'tool_call', 'manual', 'test_tool_2', '{"param": "value2"}', NOW() - INTERVAL '5 minutes'),
       ($1, $2, 'message_reply', 'manual', NULL, NULL, NOW() - INTERVAL '2 minutes')`,
      [testAgentId, testRunId]
    );
  });

  afterAll(async () => {
    const pool = getDb();
    // Cleanup in reverse dependency order — including the nodes rows the
    // agent/thread rows hang off (deleting only the domain rows leaks nodes).
    await pool.query(`DELETE FROM agent_activity_log WHERE agent_id = $1`, [testAgentId]);
    await pool.query(`DELETE FROM runs WHERE agent_id = $1`, [testAgentId]);
    await pool.query(`DELETE FROM threads WHERE id = $1`, [testThreadId]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [testAgentId]);
    await pool.query(`DELETE FROM nodes WHERE id IN ($1, $2)`, [testAgentId, testThreadId]);
  });

  it('returns recent activity for agent_name alone', async () => {
    const context = { agentId: 'caller-agent-id', threadId: testThreadId };
    const result = await handler({ agent_name: 'TestAgent_ARA_v2' }, {}, context);
    const parsed = JSON.parse(result);

    // Output shape
    expect(parsed).toHaveProperty('agent');
    expect(parsed).toHaveProperty('count');
    expect(parsed).toHaveProperty('has_more');
    expect(parsed).toHaveProperty('oldest_entry_time');
    expect(parsed).toHaveProperty('runs');
    expect(parsed).toHaveProperty('entries');

    // Assert agent resolution worked
    expect(parsed.agent.id).toBe(testAgentId);
    expect(parsed.agent.name).toBe('TestAgent_ARA_v2');

    // Assert entries are returned
    expect(parsed.count).toBeGreaterThan(0);
    expect(Array.isArray(parsed.entries)).toBe(true);

    // Assert entry shape
    const entry = parsed.entries[0];
    expect(entry).toHaveProperty('time');
    expect(entry).toHaveProperty('run_id');
    expect(entry).toHaveProperty('action');
  });

  it('filters by run_id', async () => {
    const context = { agentId: 'caller-agent-id', threadId: testThreadId };
    const result = await handler(
      { agent_name: 'TestAgent_ARA_v2', run_id: testRunId },
      {},
      context
    );
    const parsed = JSON.parse(result);

    // Should only return entries from the specified run
    expect(parsed.entries.every((e: { run_id?: string }) => e.run_id === testRunId)).toBe(true);
  });

  it('filters to the last_n_runs runs', async () => {
    const context = { agentId: 'caller-agent-id', threadId: testThreadId };
    const result = await handler({ agent_name: 'TestAgent_ARA_v2', last_n_runs: 1 }, {}, context);
    const parsed = JSON.parse(result);

    // Should restrict to last N runs
    expect(parsed.count).toBeGreaterThan(0);
  });

  it('scopes to thread_id', async () => {
    const context = { agentId: 'caller-agent-id', threadId: 'different-thread-id' };
    const result = await handler(
      { agent_name: 'TestAgent_ARA_v2', thread_id: testThreadId },
      {},
      context
    );
    const parsed = JSON.parse(result);

    // Should return entries from the specified thread
    expect(parsed.count).toBeGreaterThan(0);
  });

  it('queries all threads when thread_id is null', async () => {
    const context = { agentId: 'caller-agent-id', threadId: testThreadId };
    const result = await handler({ agent_name: 'TestAgent_ARA_v2', thread_id: null }, {}, context);
    const parsed = JSON.parse(result);

    // Should query across all threads
    expect(parsed.count).toBeGreaterThan(0);
  });

  it('filters by action_type', async () => {
    const context = { agentId: 'caller-agent-id', threadId: testThreadId };
    const result = await handler(
      { agent_name: 'TestAgent_ARA_v2', action_type: 'tool_call' },
      {},
      context
    );
    const parsed = JSON.parse(result);

    // Should only return tool_call actions
    expect(parsed.entries.every((e: { action?: string }) => e.action === 'tool_call')).toBe(true);
    expect(parsed.count).toBe(2); // We inserted 2 tool_call entries
  });

  it('respects limit', async () => {
    const context = { agentId: 'caller-agent-id', threadId: testThreadId };
    const result = await handler({ agent_name: 'TestAgent_ARA_v2', limit: 1 }, {}, context);
    const parsed = JSON.parse(result);

    // Should respect limit
    expect(parsed.count).toBeLessThanOrEqual(1);
  });

  it('errors when no agent matches', async () => {
    const context = { agentId: 'caller-agent-id', threadId: testThreadId };
    const result = await handler({ agent_name: 'NonexistentAgent_XYZ_v2' }, {}, context);
    const parsed = JSON.parse(result);

    // Should return teaching error
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toContain('No agent matched');
    expect(parsed).toHaveProperty('hint');
  });

  it('errors on an ambiguous agent name', async () => {
    const pool = getDb();

    // A second agent so both match a partial query. Agents are actors, not
    // nodes: insert into the agents table only, no `nodes` row.
    const agent2Id = `agent-${randomUUID()}`;

    await pool.query(
      `INSERT INTO agents (id, name, role, system_prompt)
       VALUES ($1, $2, $3, $4)`,
      [agent2Id, 'TestAgent_ARA_v2_Variant', 'Test Role', 'Test prompt']
    );

    const context = { agentId: 'caller-agent-id', threadId: testThreadId };
    // Query with a partial name that matches both agents
    const result = await handler({ agent_name: 'TestAgent_ARA' }, {}, context);
    const parsed = JSON.parse(result);

    // Should return disambiguation error
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toContain('Ambiguous');
    expect(parsed).toHaveProperty('candidates');
    expect(Array.isArray(parsed.candidates)).toBe(true);
    expect(parsed.candidates.length).toBeGreaterThan(1);

    // Cleanup
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agent2Id]);
  });

  it('returns has_more and oldest_entry_time pagination signals', async () => {
    const context = { agentId: 'caller-agent-id', threadId: testThreadId };
    const result = await handler({ agent_name: 'TestAgent_ARA_v2', limit: 1 }, {}, context);
    const parsed = JSON.parse(result);

    // has_more should be true when results are truncated
    expect(parsed).toHaveProperty('has_more');
    expect(typeof parsed.has_more).toBe('boolean');

    // oldest_entry_time should be a timestamp
    expect(parsed).toHaveProperty('oldest_entry_time');
    if (parsed.count > 0) {
      expect(typeof parsed.oldest_entry_time).toBe('string');
    }
  });

  it('includes input_summary only with include_input_preview', async () => {
    const context = { agentId: 'caller-agent-id', threadId: testThreadId };

    // Default: lean entries, no input preview.
    const lean = JSON.parse(
      await handler({ agent_name: 'TestAgent_ARA_v2', action_type: 'tool_call' }, {}, context)
    );
    lean.entries.forEach((e: Record<string, unknown>) => {
      expect(e).not.toHaveProperty('input_summary');
    });

    // Opt-in: tool_call entries carry a truncated input preview.
    const verbose = JSON.parse(
      await handler(
        { agent_name: 'TestAgent_ARA_v2', action_type: 'tool_call', include_input_preview: true },
        {},
        context
      )
    );
    const toolCallEntries = verbose.entries.filter(
      (e: { action?: string }) => e.action === 'tool_call'
    );
    expect(toolCallEntries.length).toBeGreaterThan(0);
    toolCallEntries.forEach((e: { input_summary?: string }) => {
      expect(e).toHaveProperty('input_summary');
      if (e.input_summary) {
        expect(e.input_summary.length).toBeLessThanOrEqual(200);
      }
    });
  });

  it('returns runs metadata for every run', async () => {
    const context = { agentId: 'caller-agent-id', threadId: testThreadId };
    const result = await handler({ agent_name: 'TestAgent_ARA_v2' }, {}, context);
    const parsed = JSON.parse(result);

    // Assert runs object is populated
    expect(Object.keys(parsed.runs).length).toBeGreaterThan(0);

    // Assert run metadata shape
    const runMeta = parsed.runs[testRunId];
    expect(runMeta).toHaveProperty('status');
    expect(runMeta).toHaveProperty('model');
    expect(runMeta).toHaveProperty('started_at');
    expect(runMeta).toHaveProperty('finished_at');
  });
});
