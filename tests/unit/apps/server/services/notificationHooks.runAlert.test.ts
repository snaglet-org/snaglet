/**
 * The per-thread run-alert decision in notifyRunEnd: who gets a
 * `thread.run_alert`, and that the tray entry is unaffected either way.
 *
 * Covered: disabled / unconfigured threads stay silent; an enabled thread
 * alerts on completed and failed; each toggle suppresses only its own
 * outcome; an aborted run never alerts (and makes no tray entry either); a
 * question reply still alerts; a subagent helper's dropped notification
 * alerts nothing; a settings-read failure never breaks the run.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { NotificationRecord, ThreadNotificationSettings } from '@snaglet/shared/types';

const create = jest.fn<(params: Record<string, unknown>) => Promise<NotificationRecord | null>>();
const getSettings = jest.fn<(threadId: string) => Promise<ThreadNotificationSettings | null>>();
const emitAlert = jest.fn<(alert: Record<string, unknown>) => void>();
const findAgent = jest.fn<(id: string) => Promise<{ id: string; name: string } | null>>();
const findThread = jest.fn<(id: string) => Promise<{ id: string; title: string } | null>>();
const findLatestAgentReply =
  jest.fn<
    (
      threadId: string,
      agentId: string
    ) => Promise<{ runId: string | null; messageType: string | null; content: string } | null>
  >();

jest.mock('@server/services/HookService', () => ({ hooks: { on: jest.fn() } }));
jest.mock('@server/services/NotificationService', () => ({
  notificationService: { create: (params: Record<string, unknown>) => create(params) },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (id: string) => findAgent(id) },
}));
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (id: string) => findThread(id) },
}));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    findLatestAgentReply: (threadId: string, agentId: string) =>
      findLatestAgentReply(threadId, agentId),
  },
}));
jest.mock('@snaglet/db/tables/thread_notification_settings', () => ({
  ThreadNotificationSettingsTable: { get: (threadId: string) => getSettings(threadId) },
}));
jest.mock('@server/realtime/surfaces/threadNotifications', () => ({
  emitThreadRunAlert: (alert: Record<string, unknown>) => emitAlert(alert),
}));
jest.mock('@server/config/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { notifyRunEnd } from '@server/services/notificationHooks';

const THREAD = 'thread-1111111111111-notifaaaa';
const RUN = 'run-1111111111111-notifaaaa';
const AGENT = 'test-agent-a';

function record(id = 'notif-1'): NotificationRecord {
  return {
    id,
    type: 'run_completed',
    title: 'Test Agent A completed',
    body: null,
    threadId: THREAD,
    agentId: AGENT,
    runId: RUN,
    read: false,
    dismissed: false,
    createdAt: '2026-10-12T00:00:00.000Z',
  };
}

function settings(patch: Partial<ThreadNotificationSettings> = {}): ThreadNotificationSettings {
  return {
    threadId: THREAD,
    enabled: true,
    sound: 'chime',
    onCompleted: true,
    onFailed: true,
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...patch,
  };
}

type Status = 'completed' | 'failed' | 'aborted';

async function runEnd(status: Status): Promise<void> {
  await notifyRunEnd({ runId: RUN, agentId: AGENT, threadId: THREAD, status });
}

describe('notifyRunEnd — per-thread run alerts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    create.mockResolvedValue(record());
    findAgent.mockResolvedValue({ id: AGENT, name: 'Test Agent A' });
    findThread.mockResolvedValue({ id: THREAD, title: 'Build the thing' });
    // No question reply: the plain run_completed path.
    findLatestAgentReply.mockResolvedValue(null);
    getSettings.mockResolvedValue(null);
  });

  it('stays silent for a thread that was never configured', async () => {
    await runEnd('completed');
    expect(create).toHaveBeenCalledTimes(1); // the tray entry still happens
    expect(emitAlert).not.toHaveBeenCalled();
  });

  it('stays silent when the master switch is off', async () => {
    getSettings.mockResolvedValue(settings({ enabled: false }));
    await runEnd('completed');
    expect(emitAlert).not.toHaveBeenCalled();
  });

  it('alerts on a completed run, with the tray wording and the chosen sound', async () => {
    getSettings.mockResolvedValue(settings({ sound: 'marimba' }));
    await runEnd('completed');

    expect(create).toHaveBeenCalledTimes(1);
    expect(emitAlert).toHaveBeenCalledTimes(1);
    const [alert] = emitAlert.mock.calls[0]!;
    expect(alert).toEqual({
      threadId: THREAD,
      runId: RUN,
      status: 'completed',
      sound: 'marimba',
      title: 'Test Agent A completed',
      body: 'Test Agent A finished in \u201cBuild the thing\u201d.',
      notificationId: 'notif-1',
    });
    // The alert is not a second tray entry.
    expect(create.mock.calls[0]![0]).toMatchObject({ type: 'run_completed' });
  });

  it('alerts on a failed run', async () => {
    getSettings.mockResolvedValue(settings());
    await runEnd('failed');
    expect(emitAlert).toHaveBeenCalledTimes(1);
    expect(emitAlert.mock.calls[0]![0]).toMatchObject({
      status: 'failed',
      title: 'Test Agent A failed',
    });
  });

  it('never alerts for an aborted run — the user stopped it', async () => {
    getSettings.mockResolvedValue(settings());
    await runEnd('aborted');
    expect(create).not.toHaveBeenCalled();
    expect(emitAlert).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
  });

  it('honors "when a run finishes" off while still alerting on failure', async () => {
    getSettings.mockResolvedValue(settings({ onCompleted: false }));
    await runEnd('completed');
    expect(emitAlert).not.toHaveBeenCalled();

    await runEnd('failed');
    expect(emitAlert).toHaveBeenCalledTimes(1);
    expect(emitAlert.mock.calls[0]![0]).toMatchObject({ status: 'failed' });
  });

  it('honors "when a run fails" off while still alerting on completion', async () => {
    getSettings.mockResolvedValue(settings({ onFailed: false }));
    await runEnd('failed');
    expect(emitAlert).not.toHaveBeenCalled();

    await runEnd('completed');
    expect(emitAlert).toHaveBeenCalledTimes(1);
    expect(emitAlert.mock.calls[0]![0]).toMatchObject({ status: 'completed' });
  });

  it('alerts for a run that ended on a question, reusing the mention wording', async () => {
    getSettings.mockResolvedValue(settings());
    create.mockResolvedValue({
      ...record('notif-ask'),
      type: 'mention',
      title: 'Test Agent A has a question for you',
    });
    findLatestAgentReply.mockResolvedValue({
      runId: RUN,
      messageType: 'question',
      content: 'Which branch should I use?',
    });

    await runEnd('completed');
    expect(emitAlert).toHaveBeenCalledTimes(1);
    expect(emitAlert.mock.calls[0]![0]).toMatchObject({
      status: 'completed',
      notificationId: 'notif-ask',
    });
  });

  it("raises nothing for a subagent helper's run, whose notification is dropped", async () => {
    getSettings.mockResolvedValue(settings());
    create.mockResolvedValue(null);
    await runEnd('completed');
    expect(emitAlert).not.toHaveBeenCalled();
  });

  it('swallows a settings-read failure instead of failing the run', async () => {
    getSettings.mockRejectedValue(new Error('db down'));
    await expect(runEnd('completed')).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(emitAlert).not.toHaveBeenCalled();
  });

  it('does not alert for a run with no thread', async () => {
    getSettings.mockResolvedValue(settings());
    await notifyRunEnd({ runId: RUN, agentId: AGENT, status: 'completed' });
    expect(emitAlert).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
  });
});
