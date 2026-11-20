/**
 * A workspace with one subagent helper next to its visible twin, for the
 * helper-visibility suites.
 *
 *   project (container, category 'project')
 *     ├── visible thread    — a real agent's message and current summary
 *     └── helper thread     — parent_thread_id = visible thread; the helper
 *                             agent's message and summary
 *
 * Both threads, messages and summaries carry the same distinctive word and
 * the helper agent shares the real agent's name, so any lane that leaks a
 * helper returns it beside the visible row instead of merely possibly.
 */

import { Agents, Containers, Messages, ThreadSummaries, Threads } from '@snaglet/db';

export const WORD = 'Quillfeather';

export const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
export const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
export const HELPER_THREAD_ID = 'thread-2222222222222-bbbbbbbbb';
export const AGENT_ID = 'test-agent-a';
export const AGENT_NAME = 'Test Agent A';
export const HELPER_AGENT_ID = 'subagent-11111111-1111-4111-8111-111111111111';
export const MESSAGE_ID = 'message-1111111111111-aaaaaaaaa';
export const HELPER_MESSAGE_ID = 'message-2222222222222-bbbbbbbbb';
export const SUMMARY_ID = 'thread_summary-1111111111111-aaaaaaaaa';
export const HELPER_SUMMARY_ID = 'thread_summary-2222222222222-bbbbbbbbb';

export async function seedHelperWorkspace(): Promise<void> {
  await Containers.create({ id: PROJECT_ID, name: `${WORD} Project`, category: 'project' });
  await Agents.create({ id: AGENT_ID, name: AGENT_NAME, role: 'Test role' });
  await Agents.create({
    id: HELPER_AGENT_ID,
    name: AGENT_NAME,
    role: 'subagent',
    parentAgentId: AGENT_ID,
  });
  await Threads.create({ id: THREAD_ID, title: `${WORD} planning`, projectId: PROJECT_ID });
  await Threads.create({
    id: HELPER_THREAD_ID,
    title: `${AGENT_NAME} › ${WORD} scout`,
    projectId: PROJECT_ID,
    parentThreadId: THREAD_ID,
  });
  await Messages.create({
    id: MESSAGE_ID,
    threadId: THREAD_ID,
    role: 'assistant',
    agentId: AGENT_ID,
    content: `The ${WORD} ledger is reconciled.`,
  });
  await Messages.create({
    id: HELPER_MESSAGE_ID,
    threadId: HELPER_THREAD_ID,
    role: 'assistant',
    agentId: HELPER_AGENT_ID,
    content: `The ${WORD} ledger draft from the helper.`,
  });
  await ThreadSummaries.insertNewVersion({
    id: SUMMARY_ID,
    threadId: THREAD_ID,
    agentId: AGENT_ID,
    summaryText: `The team reconciled the ${WORD} ledger.`,
    messagesCovered: 1,
  });
  await ThreadSummaries.insertNewVersion({
    id: HELPER_SUMMARY_ID,
    threadId: HELPER_THREAD_ID,
    agentId: HELPER_AGENT_ID,
    summaryText: `The helper drafted the ${WORD} ledger.`,
    messagesCovered: 1,
  });
}
