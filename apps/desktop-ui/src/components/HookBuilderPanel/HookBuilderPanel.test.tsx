import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookWorkspaceInfo } from '@desktop/utils/api';
import { emitLibraryEvent, onLibraryEvent } from '@desktop/utils/workspaceEvents';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  save: vi.fn(),
  updateFiles: vi.fn(),
  readFile: vi.fn(),
  status: vi.fn(),
  setEnabled: vi.fn(),
  setRunAs: vi.fn(),
  setUnattendedPolicy: vi.fn(),
  check: vi.fn(),
  run: vi.fn(),
}));
const agentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const schedulesApi = vi.hoisted(() => ({
  list: vi.fn(),
  setEnabled: vi.fn(),
  runNow: vi.fn(),
  runs: vi.fn(),
}));
const hookRunsApi = vi.hoisted(() => ({
  listForHook: vi.fn(),
  clearForHook: vi.fn(),
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, hooksWorkspacesApi: api, schedulesApi, hookRunsApi, agentsApi };
});
vi.mock('@desktop/ws/useWs', () => ({ useWsChannel: () => ({ lastMessage: null }) }));
vi.mock('../HandlerEditor/HandlerEditor', () => ({
  HandlerEditor: ({
    value,
    onChange,
    fillHeight,
    enableDropInsert,
    'aria-label': ariaLabel,
  }: {
    value: string;
    onChange: (next: string) => void;
    fillHeight?: boolean;
    enableDropInsert?: boolean;
    'aria-label'?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      data-fill-height={String(Boolean(fillHeight))}
      data-drop-insert={String(Boolean(enableDropInsert))}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

import { HookBuilderPanel } from './HookBuilderPanel';

const workspace: HookWorkspaceInfo = {
  hookName: 'agent-message-tracker',
  dir: '/tmp/agent-message-tracker',
  homeRelativeDir: '/tmp/agent-message-tracker',
  files: ['hook.ts'],
  hasBuild: true,
};
const code = `import { defineHook } from '@snaglet/sdk';\nexport default defineHook({ on: 'message:create', async run() {} });\n`;

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  Object.values(schedulesApi).forEach((fn) => fn.mockReset());
  schedulesApi.list.mockResolvedValue([]);
  // Unregistered by default — the enable/disable control stays hidden, so
  // existing cases see the header exactly as they did before.
  api.status.mockRejectedValue(new Error('not registered'));
  hookRunsApi.listForHook.mockReset();
  hookRunsApi.listForHook.mockResolvedValue([]);
  hookRunsApi.clearForHook.mockReset();
  hookRunsApi.clearForHook.mockResolvedValue({
    hookName: workspace.hookName,
    deletedRuns: 0,
  });
  agentsApi.list.mockReset();
  agentsApi.list.mockResolvedValue([
    { id: 'test-agent-b', name: 'Test Agent B' },
    { id: 'test-agent-a', name: 'Test Agent A' },
  ]);
});

describe('HookBuilderPanel code-first editor', () => {
  it('opens directly on a full-height editor with no separate Details or Test tabs', async () => {
    api.readFile.mockResolvedValue(code);
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);
    const editor = await screen.findByLabelText(/hook\.ts observer code/i);
    const testConsole = screen.getByRole('button', { name: /test console/i });
    expect(editor).toHaveAttribute('data-fill-height', 'true');
    expect(editor).toHaveAttribute('data-drop-insert', 'true');
    expect(
      testConsole.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /details/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^test$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^code$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^runs$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /schedules/i })).toBeInTheDocument();
  });

  it('hides the enable control until the hook is registered', async () => {
    api.readFile.mockResolvedValue(code);
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    await screen.findByLabelText(/hook\.ts observer code/i);
    expect(screen.queryByRole('button', { name: /^(enable|disable)$/i })).not.toBeInTheDocument();
  });

  it('shows who a registered hook runs as and saves a new pick at once', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    api.status.mockResolvedValue({ name: workspace.hookName, enabled: true, runAsAgentId: null });
    api.setRunAs.mockResolvedValue({
      name: workspace.hookName,
      enabled: true,
      runAsAgentId: 'test-agent-a',
    });
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    const picker = await screen.findByRole('combobox', { name: 'Runs as' });
    await waitFor(() => expect(picker).toBeEnabled());
    expect(picker).toHaveValue('');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['System (default)', 'Test Agent A', 'Test Agent B']);

    await user.selectOptions(picker, 'test-agent-a');

    await waitFor(() =>
      expect(api.setRunAs).toHaveBeenCalledWith(workspace.hookName, 'test-agent-a')
    );
    await waitFor(() => expect(picker).toHaveValue('test-agent-a'));
  });

  it('shows the refusal when the server rejects the pick, and clears back to System', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    api.status.mockResolvedValue({
      name: workspace.hookName,
      enabled: true,
      runAsAgentId: 'test-agent-gone',
    });
    api.setRunAs
      .mockRejectedValueOnce(new Error('agent "Test Agent B" is archived'))
      .mockResolvedValueOnce({ name: workspace.hookName, enabled: true, runAsAgentId: null });
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    const picker = await screen.findByRole('combobox', { name: 'Runs as' });
    await waitFor(() => expect(picker).toBeEnabled());
    // A saved agent missing from the active list still shows, marked.
    expect(picker).toHaveValue('test-agent-gone');
    expect(
      within(picker).getByRole('option', { name: 'test-agent-gone (unavailable)' })
    ).toBeTruthy();

    await user.selectOptions(picker, 'test-agent-b');
    expect(await screen.findByRole('alert')).toHaveTextContent('is archived');
    expect(picker).toHaveValue('test-agent-gone');

    await user.selectOptions(picker, '');
    await waitFor(() => expect(api.setRunAs).toHaveBeenLastCalledWith(workspace.hookName, null));
    await waitFor(() => expect(picker).toHaveValue(''));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('disables a registered hook and reflects the row the server returns', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    api.status.mockResolvedValue({ name: workspace.hookName, enabled: true });
    api.setEnabled.mockResolvedValue({ name: workspace.hookName, enabled: false });
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /^disable$/i }));

    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith(workspace.hookName, false));
    expect(await screen.findByRole('button', { name: /^enable$/i })).toBeInTheDocument();
    expect(screen.getByText(/^Disabled$/)).toBeInTheDocument();
  });

  it('sets what a run this hook wakes does with a tool call that asks', async () => {
    api.readFile.mockResolvedValue(code);
    api.status.mockResolvedValue({
      name: workspace.hookName,
      enabled: true,
      unattendedPolicy: 'skip',
    });
    api.setUnattendedPolicy.mockResolvedValue({
      name: workspace.hookName,
      enabled: true,
      unattendedPolicy: 'auto-approve-allowed',
    });
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    const policy = (await screen.findByLabelText(
      /tool calls that ask for a person/i
    )) as HTMLSelectElement;
    expect(policy.value).toBe('skip');
    fireEvent.change(policy, { target: { value: 'auto-approve-allowed' } });

    await waitFor(() =>
      expect(api.setUnattendedPolicy).toHaveBeenCalledWith(
        workspace.hookName,
        'auto-approve-allowed'
      )
    );
    await waitFor(() => expect(policy.value).toBe('auto-approve-allowed'));
  });

  it('tells the Hooks sidebar about its flip and follows a flip made there', async () => {
    const user = userEvent.setup();
    const heard: unknown[] = [];
    const stop = onLibraryEvent((event) => {
      if (event.type === 'hook-enabled-changed') heard.push(event);
    });
    api.readFile.mockResolvedValue(code);
    api.status.mockResolvedValue({ name: workspace.hookName, enabled: true });
    api.setEnabled.mockResolvedValue({ name: workspace.hookName, enabled: false });
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /^disable$/i }));
    await waitFor(() =>
      expect(heard).toEqual([
        { type: 'hook-enabled-changed', hookName: workspace.hookName, enabled: false },
      ])
    );

    act(() =>
      emitLibraryEvent({
        type: 'hook-enabled-changed',
        hookName: workspace.hookName,
        enabled: true,
      })
    );
    expect(await screen.findByRole('button', { name: /^disable$/i })).toBeInTheDocument();
    expect(screen.getByText(/^Enabled$/)).toBeInTheDocument();
    act(() =>
      emitLibraryEvent({ type: 'hook-enabled-changed', hookName: 'other', enabled: false })
    );
    expect(screen.getByText(/^Enabled$/)).toBeInTheDocument();
    stop();
  });

  it('names the toggle in words while it is going, not with a bare ellipsis', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    api.status.mockResolvedValue({ name: workspace.hookName, enabled: true });
    let release!: () => void;
    api.setEnabled.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ name: workspace.hookName, enabled: false });
        })
    );
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /^disable$/i }));

    expect(screen.getByRole('button', { name: 'Disabling…' })).toBeDisabled();
    await act(async () => release());
    expect(await screen.findByRole('button', { name: /^enable$/i })).toBeEnabled();
  });

  it('surfaces a failed toggle without flipping the displayed state', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    api.status.mockResolvedValue({ name: workspace.hookName, enabled: true });
    api.setEnabled.mockRejectedValue(new Error('registry is locked'));
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /^disable$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/registry is locked/);
    expect(screen.getByRole('button', { name: /^disable$/i })).toBeInTheDocument();
    expect(screen.getByText(/^Enabled$/)).toBeInTheDocument();
  });

  it('opens the durable run ledger for the current hook', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(await screen.findByRole('tab', { name: /^runs$/i }));

    await waitFor(() =>
      expect(hookRunsApi.listForHook).toHaveBeenCalledWith(workspace.hookName, 100)
    );
    expect(
      screen.getByRole('region', { name: `Runs for ${workspace.hookName}` })
    ).toHaveTextContent(/No runs yet/);
  });

  it('names the agent a run acted as', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    hookRunsApi.listForHook.mockResolvedValue([
      {
        id: 'hook-run-as',
        hookName: workspace.hookName,
        source: 'event',
        eventName: 'table_entry:update',
        status: 'succeeded',
        agentId: 'test-agent-a',
        threadId: null,
        durationMs: 12,
        exitCode: 0,
        stdout: '',
        stderr: '',
        startedAt: '2026-07-29T12:00:00.000Z',
        finishedAt: '2026-07-29T12:00:00.012Z',
      },
    ]);
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(await screen.findByRole('tab', { name: /^runs$/i }));

    const row = await screen.findByLabelText('table_entry:update: succeeded');
    await waitFor(() => expect(row).toHaveTextContent('as Test Agent A'));
    expect(agentsApi.list).toHaveBeenCalledWith({ includeArchived: true });
  });

  it('renders persisted run status, source, duration, and output', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    hookRunsApi.listForHook.mockResolvedValue([
      {
        id: 'hook-run-1',
        hookName: workspace.hookName,
        source: 'manual',
        eventName: 'message:create',
        status: 'failed',
        agentId: null,
        threadId: null,
        durationMs: 42,
        exitCode: 1,
        stdout: '',
        stderr: 'boom',
        startedAt: '2026-07-29T12:00:00.000Z',
        finishedAt: '2026-07-29T12:00:00.042Z',
      },
    ]);
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(await screen.findByRole('tab', { name: /^runs$/i }));

    const row = await screen.findByLabelText('message:create: failed');
    expect(row).toHaveTextContent('Manual');
    expect(row).toHaveTextContent('42ms');
    expect(row).toHaveTextContent('exit 1');
    await user.click(screen.getByText('Output'));
    expect(row).toHaveTextContent('boom');
  });

  it('confirms through the in-app dialog (never window.confirm), clears durable history, and reloads the open ledger', async () => {
    const user = userEvent.setup();
    const nativeConfirm = vi.spyOn(window, 'confirm');
    api.readFile.mockResolvedValue(code);
    hookRunsApi.listForHook
      .mockResolvedValueOnce([
        {
          id: 'hook-run-clear-me',
          hookName: workspace.hookName,
          source: 'event',
          eventName: 'message:create',
          status: 'succeeded',
          agentId: null,
          threadId: null,
          durationMs: 12,
          exitCode: 0,
          stdout: '',
          stderr: '',
          startedAt: '2026-07-29T12:00:00.000Z',
          finishedAt: '2026-07-29T12:00:00.012Z',
        },
      ])
      .mockResolvedValue([]);
    hookRunsApi.clearForHook.mockResolvedValue({
      hookName: workspace.hookName,
      deletedRuns: 1,
    });
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(await screen.findByRole('tab', { name: /^runs$/i }));
    await screen.findByLabelText('message:create: succeeded');
    await user.click(screen.getByRole('button', { name: /clear history/i }));

    // The confirmation is the in-app ConfirmModal — window.confirm is
    // suppressed in the Tauri webview, so it must never be consulted.
    const dialog = screen.getByRole('dialog', { name: /clear all run history/i });
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(hookRunsApi.clearForHook).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Clear history' }));

    await waitFor(() => expect(hookRunsApi.clearForHook).toHaveBeenCalledWith(workspace.hookName));
    await waitFor(() => expect(hookRunsApi.listForHook).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a read from before Clear history does not bring the cleared runs back', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    const oldRun = {
      id: 'hook-run-cleared',
      hookName: workspace.hookName,
      source: 'event',
      eventName: 'message:create',
      status: 'succeeded',
      agentId: null,
      threadId: null,
      durationMs: 12,
      exitCode: 0,
      stdout: '',
      stderr: '',
      startedAt: '2026-07-29T12:00:00.000Z',
      finishedAt: '2026-07-29T12:00:00.012Z',
    };
    let releaseRefresh!: () => void;
    hookRunsApi.listForHook
      .mockResolvedValueOnce([oldRun])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRefresh = () => resolve([oldRun]);
          })
      )
      .mockResolvedValue([]);
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(await screen.findByRole('tab', { name: /^runs$/i }));
    await screen.findByLabelText('message:create: succeeded');
    await user.click(screen.getByRole('button', { name: /^refresh$/i }));
    await user.click(screen.getByRole('button', { name: /clear history/i }));
    await user.click(
      within(screen.getByRole('dialog', { name: /clear all run history/i })).getByRole('button', {
        name: 'Clear history',
      })
    );
    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();

    await act(async () => releaseRefresh());

    expect(screen.queryByLabelText('message:create: succeeded')).not.toBeInTheDocument();
    expect(screen.getByText(/no runs yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^refresh$/i })).toBeEnabled();
  });

  it('says the run history could not load instead of claiming there are no runs', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    hookRunsApi.listForHook.mockRejectedValue(new Error('ledger offline'));
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(await screen.findByRole('tab', { name: /^runs$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/ledger offline/);
    expect(screen.queryByText(/no runs yet/i)).not.toBeInTheDocument();
  });

  it('canceling the clear-history dialog is a strict no-op', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(await screen.findByRole('tab', { name: /^runs$/i }));
    await user.click(await screen.findByRole('button', { name: /clear history/i }));
    const dialog = screen.getByRole('dialog', { name: /clear all run history/i });

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(hookRunsApi.clearForHook).not.toHaveBeenCalled();
  });

  it('keeps history visible and surfaces a clear conflict', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    hookRunsApi.listForHook.mockResolvedValue([
      {
        id: 'hook-run-active',
        hookName: workspace.hookName,
        source: 'event',
        eventName: 'message:create',
        status: 'running',
        agentId: null,
        threadId: null,
        durationMs: null,
        exitCode: null,
        stdout: '',
        stderr: '',
        startedAt: '2026-07-29T12:00:00.000Z',
        finishedAt: null,
      },
    ]);
    hookRunsApi.clearForHook.mockRejectedValue(new Error('queued or running invocation'));
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(await screen.findByRole('tab', { name: /^runs$/i }));
    await screen.findByLabelText('message:create: running');
    await user.click(screen.getByRole('button', { name: /clear history/i }));
    await user.click(
      within(screen.getByRole('dialog', { name: /clear all run history/i })).getByRole('button', {
        name: 'Clear history',
      })
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/queued or running invocation/i);
    expect(screen.getByLabelText('message:create: running')).toBeInTheDocument();
  });

  it('saves hook.ts without mirroring trigger or filter fields', async () => {
    const user = userEvent.setup();
    const changed = `${code}// changed\n`;
    api.readFile.mockResolvedValue(code);
    api.updateFiles.mockResolvedValue({ workspace });
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(/hook\.ts observer code/i), {
      target: { value: changed },
    });
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(api.updateFiles).toHaveBeenCalledWith(workspace.hookName, { 'hook.ts': changed });
  });

  it('keeps typing that lands while the test console saves before a run', async () => {
    const user = userEvent.setup();
    const scheduleCode = `import { defineHook } from '@snaglet/sdk';\nexport default defineHook({ schedule: [{ every: '1h' }], on: 'schedule:fire', async run() {} });\n`;
    const first = `${scheduleCode}// first\n`;
    const second = `${first}// second\n`;
    api.readFile.mockResolvedValue(scheduleCode);
    api.check.mockResolvedValue({
      registration: { buildStatus: 'ready', lastError: null },
      declared: { events: ['schedule:fire'], filter: null, schedules: [] },
    });
    api.run.mockResolvedValue({ runs: [] });
    let releaseSave!: () => void;
    api.updateFiles.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSave = () => resolve({ workspace });
        })
    );
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);
    const editor = await screen.findByLabelText(/hook\.ts observer code/i);
    fireEvent.change(editor, { target: { value: first } });

    await user.click(screen.getByRole('button', { name: /test console/i }));
    await user.click(screen.getByRole('button', { name: /^run test$/i }));
    await waitFor(() =>
      expect(api.updateFiles).toHaveBeenCalledWith(workspace.hookName, { 'hook.ts': first })
    );
    fireEvent.change(editor, { target: { value: second } });
    await act(async () => releaseSave());

    expect(editor).toHaveValue(second);
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
  });

  it('does not rewrite an unchanged hook', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    const onSaved = vi.fn();
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={onSaved} />);
    await screen.findByLabelText(/hook\.ts observer code/i);
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(api.updateFiles).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(workspace);
  });

  it('Cancel with dirty code opens the in-app discard dialog (never window.confirm); confirming discards and closes', async () => {
    const user = userEvent.setup();
    const nativeConfirm = vi.spyOn(window, 'confirm');
    api.readFile.mockResolvedValue(code);
    const onClose = vi.fn();
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={onClose} onSaved={vi.fn()} />);
    const editor = await screen.findByLabelText(/hook\.ts observer code/i);
    fireEvent.change(editor, { target: { value: `${code}// dirty\n` } });

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    const dialog = screen.getByRole('dialog', { name: 'Discard unsaved changes?' });
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Discard changes' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    // The in-flight edit is reset, not just abandoned — pane hosts may keep
    // this component mounted through onClose (see handleRequestClose).
    expect(screen.getByLabelText(/hook\.ts observer code/i)).toHaveValue(code);
  });

  it('canceling the discard dialog keeps the edits and never closes', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    const onClose = vi.fn();
    const dirty = `${code}// dirty\n`;
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(/hook\.ts observer code/i), {
      target: { value: dirty },
    });

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    const dialog = screen.getByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/hook\.ts observer code/i)).toHaveValue(dirty);
  });

  it('Cancel with clean code closes directly — no dialog interposed', async () => {
    const user = userEvent.setup();
    api.readFile.mockResolvedValue(code);
    const onClose = vi.fn();
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={onClose} onSaved={vi.fn()} />);
    await screen.findByLabelText(/hook\.ts observer code/i);

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks editing after a read failure and supports retry', async () => {
    const user = userEvent.setup();
    api.readFile.mockRejectedValueOnce(new Error('disk offline')).mockResolvedValueOnce(code);
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/disk offline/i);
    await user.click(screen.getByRole('button', { name: /retry loading/i }));
    expect(await screen.findByLabelText(/hook\.ts observer code/i)).toHaveValue(code);
  });

  it('asks for the folder id only when creating a hook', async () => {
    const user = userEvent.setup();
    api.save.mockResolvedValue({ workspace: { ...workspace, hookName: 'new-hook' } });
    render(<HookBuilderPanel mode="create" onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/script name/i), 'new-hook');
    await user.click(screen.getByRole('button', { name: /create script/i }));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    expect(api.save.mock.calls[0][0]).toBe('new-hook');
    expect(api.save.mock.calls[0][1]['hook.ts']).toContain("on: 'message:create'");
  });
});

/**
 * hook.ts changing underneath an open editor.
 *
 * With authoring handed to an agent in a thread, this is a routine sequence:
 * open the hook, hand the work off, watch the agent write the file, come
 * back. Saving is a full-file overwrite, so a stale buffer must never win by
 * default.
 */
describe('HookBuilderPanel external hook.ts changes', () => {
  const agentCode = `${code}// written by the agent\n`;
  const myCode = `${code}// typed by me\n`;

  const openEditor = async () => {
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);
    return screen.findByLabelText(/hook\.ts observer code/i);
  };

  it('refreshes a clean editor from disk without saying anything', async () => {
    api.readFile.mockResolvedValueOnce(code).mockResolvedValue(agentCode);
    const editor = await openEditor();

    fireEvent.focus(window);

    await waitFor(() => expect(editor).toHaveValue(agentCode));
    expect(screen.queryByText(/changed on disk/i)).not.toBeInTheDocument();
  });

  it('hears a focus that lands the moment the editor appears', async () => {
    // The focus fires from a MutationObserver, before React's passive effects
    // run, so a listener installed in a passive effect would miss it.
    api.readFile.mockResolvedValueOnce(code).mockResolvedValue(agentCode);
    const appeared = new Promise<HTMLElement>((resolve) => {
      const observer = new MutationObserver(() => {
        const el = screen.queryByLabelText(/hook\.ts observer code/i);
        if (!el) return;
        observer.disconnect();
        fireEvent.focus(window);
        resolve(el);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);
    const editor = await appeared;
    await waitFor(() => expect(editor).toHaveValue(agentCode));
  });

  it('keeps unsaved edits and asks, rather than refreshing over them', async () => {
    api.readFile.mockResolvedValueOnce(code).mockResolvedValue(agentCode);
    const editor = await openEditor();
    fireEvent.change(editor, { target: { value: myCode } });

    fireEvent.focus(window);

    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    expect(editor).toHaveValue(myCode);
  });

  it('refuses to save a buffer that never saw the newer file', async () => {
    // Clean load, then the agent's version on every subsequent read — the
    // pre-save check is what catches this, with no focus event involved.
    api.readFile.mockResolvedValueOnce(code).mockResolvedValue(agentCode);
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(/hook\.ts observer code/i), {
      target: { value: myCode },
    });

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    expect(api.updateFiles).not.toHaveBeenCalled();
    // The panel has to stay open — closing would strand the decision.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('saves the user’s version once they choose to keep it', async () => {
    api.readFile.mockResolvedValueOnce(code).mockResolvedValue(agentCode);
    api.updateFiles.mockResolvedValue({ workspace });
    const user = userEvent.setup();
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(/hook\.ts observer code/i), {
      target: { value: myCode },
    });
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await screen.findByText(/changed on disk/i);

    await user.click(screen.getByRole('button', { name: /keep my edits/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // The overwrite happens only because they were shown the other version.
    await waitFor(() =>
      expect(api.updateFiles).toHaveBeenCalledWith(workspace.hookName, { 'hook.ts': myCode })
    );
  });

  it('drops the edits and takes the file when the user chooses the disk copy', async () => {
    api.readFile.mockResolvedValueOnce(code).mockResolvedValue(agentCode);
    const user = userEvent.setup();
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);
    const editor = await screen.findByLabelText(/hook\.ts observer code/i);
    fireEvent.change(editor, { target: { value: myCode } });
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await screen.findByText(/changed on disk/i);

    await user.click(screen.getByRole('button', { name: /use the version on disk/i }));

    expect(editor).toHaveValue(agentCode);
    expect(screen.queryByText(/changed on disk/i)).not.toBeInTheDocument();
    // Now clean against the real file, so there is nothing left to write.
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(api.updateFiles).not.toHaveBeenCalled();
  });

  it('fails closed when the file cannot be re-read before save', async () => {
    api.readFile.mockResolvedValueOnce(code).mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    render(<HookBuilderPanel mode="edit" hook={workspace} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(/hook\.ts observer code/i), {
      target: { value: myCode },
    });

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/couldn't re-read hook\.ts before saving/i)).toBeInTheDocument();
    expect(api.updateFiles).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/hook\.ts observer code/i)).toHaveValue(myCode);
  });
});
