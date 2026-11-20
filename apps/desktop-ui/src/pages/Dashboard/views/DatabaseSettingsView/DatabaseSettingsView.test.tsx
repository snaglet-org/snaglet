import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbBackupJobStatus, DbSnapshot } from '@desktop/utils/api';
import { onLibraryEvent, type LibraryEvent } from '@desktop/utils/workspaceEvents';
import { DatabaseSettingsView } from './DatabaseSettingsView';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  download: vi.fn(),
  getStats: vi.fn(),
  backupStatus: vi.fn(),
  preUpdateCheckpoints: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({
  databaseApi: {
    snapshots: {
      list: api.list,
      create: api.create,
      remove: api.remove,
      download: api.download,
    },
    getStats: api.getStats,
    backupStatus: api.backupStatus,
    preUpdateCheckpoints: api.preUpdateCheckpoints,
    reset: api.reset,
  },
}));

const nav = vi.hoisted(() => ({ reopenForNewContent: vi.fn() }));
vi.mock('../../selection/DashboardNavigationContext', () => ({
  useDashboardNavigation: () => nav,
}));

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);

const shell = vi.hoisted(() => ({ saveDownload: vi.fn() }));
vi.mock('@desktop/socket', () => ({ socketClient: { saveDownload: shell.saveDownload } }));

type TauriWindow = { __TAURI_INTERNALS__?: unknown };

const SNAPSHOT: DbSnapshot = {
  id: 'snapshot-1',
  label: 'Test snapshot',
  createdAt: '2026-01-01T00:00:00.000Z',
  sizeBytes: 1024,
  dbName: 'snaglet',
  kind: 'manual',
  engine: 'postgres',
  format: 'custom',
  fileName: 'snapshot-1.dump',
  legacy: false,
  restorable: true,
};

const IDLE_JOB: DbBackupJobStatus = {
  running: false,
  jobId: null,
  kind: null,
  phase: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  requiresRestart: false,
  lastSnapshotId: null,
};

beforeEach(() => {
  api.list.mockReset().mockResolvedValue([SNAPSHOT]);
  api.create.mockReset().mockResolvedValue({ ...IDLE_JOB, running: true, kind: 'snapshot' });
  api.remove.mockReset().mockResolvedValue({ ok: true });
  api.download
    .mockReset()
    .mockResolvedValue({ blob: new Blob(['PGDMP']), fileName: 'snapshot-1.dump' });
  shell.saveDownload.mockReset();
  api.getStats.mockReset().mockResolvedValue({ database_size: '1 MB', tables: [] });
  api.backupStatus.mockReset().mockResolvedValue(IDLE_JOB);
  api.preUpdateCheckpoints.mockReset().mockResolvedValue({ count: 0, totalBytes: 0 });
  toast.showToast.mockReset();
  api.reset.mockReset();
  nav.reopenForNewContent.mockReset();
});

async function openDeleteConfirm() {
  const user = userEvent.setup();
  render(<DatabaseSettingsView />);
  await screen.findByText('Test snapshot');
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  return { user, dialog: screen.getByRole('dialog', { name: 'Delete snapshot?' }) };
}

describe('DatabaseSettingsView — snapshot delete', () => {
  it('asks for confirmation before deleting', async () => {
    const { dialog } = await openDeleteConfirm();

    expect(within(dialog).getByText('Test snapshot')).toBeInTheDocument();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it('cancel keeps the snapshot', async () => {
    const { user, dialog } = await openDeleteConfirm();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it('deletes the snapshot once confirmed', async () => {
    const { user, dialog } = await openDeleteConfirm();

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('snapshot-1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.showToast).toHaveBeenCalledWith('Snapshot deleted');
  });

  it('keeps the dialog open with the error when the delete fails', async () => {
    api.remove.mockRejectedValue(new Error('snapshot is locked'));
    const { user, dialog } = await openDeleteConfirm();

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('snapshot is locked');
    expect(screen.getByRole('dialog', { name: 'Delete snapshot?' })).toBeInTheDocument();
  });
});

describe('DatabaseSettingsView — snapshot download', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const createObjectURL = vi.fn(() => 'blob:http://127.0.0.1/test-snapshot');
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    delete (window as unknown as TauriWindow).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  async function clickDownload() {
    const user = userEvent.setup();
    render(<DatabaseSettingsView />);
    await screen.findByText('Test snapshot');
    await user.click(screen.getByRole('button', { name: 'Download' }));
  }

  it('saves through the native dialog in the desktop app', async () => {
    (window as unknown as TauriWindow).__TAURI_INTERNALS__ = {};
    shell.saveDownload.mockResolvedValue('/Users/test-user/Desktop/snapshot-1.dump');

    await clickDownload();

    await waitFor(() =>
      expect(shell.saveDownload).toHaveBeenCalledWith(
        expect.any(Blob),
        'snapshot-1.dump',
        'Save snapshot'
      )
    );
    expect(toast.showToast).toHaveBeenCalledWith(
      'Snapshot saved to /Users/test-user/Desktop/snapshot-1.dump',
      { durationMs: 4000 }
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('stays quiet when the native dialog is dismissed', async () => {
    (window as unknown as TauriWindow).__TAURI_INTERNALS__ = {};
    shell.saveDownload.mockResolvedValue(null);

    await clickDownload();

    await waitFor(() => expect(shell.saveDownload).toHaveBeenCalled());
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('uses a browser download outside the desktop app', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await clickDownload();

    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(shell.saveDownload).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://127.0.0.1/test-snapshot')
    );
  });
});

describe('DatabaseSettingsView — snapshot create', () => {
  it('sends one request when Create snapshot is clicked twice before the job starts', async () => {
    let accept: (job: DbBackupJobStatus) => void = () => undefined;
    api.create.mockReturnValue(new Promise<DbBackupJobStatus>((resolve) => (accept = resolve)));
    const user = userEvent.setup();
    render(<DatabaseSettingsView />);
    await screen.findByText('Test snapshot');

    const create = screen.getByRole('button', { name: 'Create snapshot' });
    await user.click(create);
    await user.click(create);

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(create).toBeDisabled();
    accept({ ...IDLE_JOB, running: true, kind: 'snapshot' });
    await waitFor(() => expect(screen.getByText(/Snapshot in progress/)).toBeInTheDocument());
  });

  it('keeps the typed label when the snapshot cannot start', async () => {
    api.create.mockRejectedValue(new Error('disk is full'));
    const user = userEvent.setup();
    render(<DatabaseSettingsView />);
    await screen.findByText('Test snapshot');

    await user.type(screen.getByRole('textbox', { name: 'Snapshot label' }), 'Before upgrade');
    await user.click(screen.getByRole('button', { name: 'Create snapshot' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('disk is full');
    expect(api.create).toHaveBeenCalledWith('Before upgrade');
    expect(screen.getByRole('textbox', { name: 'Snapshot label' })).toHaveValue('Before upgrade');
    expect(screen.getByRole('button', { name: 'Create snapshot' })).toBeEnabled();
  });

  it('clears the label once the snapshot starts', async () => {
    const user = userEvent.setup();
    render(<DatabaseSettingsView />);
    await screen.findByText('Test snapshot');

    await user.type(screen.getByRole('textbox', { name: 'Snapshot label' }), 'Before upgrade');
    await user.click(screen.getByRole('button', { name: 'Portable export' }));

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Snapshot label' })).toHaveValue('')
    );
    expect(api.create).toHaveBeenCalledWith('Before upgrade', 'plain-gzip');
  });
});

describe('DatabaseSettingsView — current database and clean slate', () => {
  it('shows the database size without a count of internal tables', async () => {
    api.getStats.mockResolvedValue({
      database_size: '15 MB',
      tables: [
        { table_name: 'docs', total_size: '1 MB', table_size: '1 MB', indexes_size: '0 bytes' },
      ],
    });
    render(<DatabaseSettingsView />);

    expect(await screen.findByText('15 MB')).toBeInTheDocument();
    expect(screen.queryByText('Tables')).toBeNull();
  });

  it('names what a clean slate keeps in one plain sentence', async () => {
    render(<DatabaseSettingsView />);
    await screen.findByText('Test snapshot');

    expect(
      screen.getByText(/Your account, providers, API keys, models, and settings are preserved\./)
    ).toBeInTheDocument();
    expect(screen.queryByText(/your your/i)).toBeNull();
  });
});

describe('DatabaseSettingsView — load failures', () => {
  it('stops showing loading placeholders when the lists cannot load', async () => {
    api.list.mockRejectedValue(new Error('snapshots unreadable'));
    api.getStats.mockRejectedValue(new Error('stats unreadable'));
    render(<DatabaseSettingsView />);

    expect(await screen.findByRole('alert')).toHaveTextContent('snapshots unreadable');
    expect(screen.getByText('Snapshots unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('Loading snapshots…')).toBeNull();
    expect(screen.queryByText('…')).toBeNull();
  });
});

describe('DatabaseSettingsView — pre-update snapshots', () => {
  it('states how many pre-update snapshots Snaglet keeps', async () => {
    render(<DatabaseSettingsView />);
    await screen.findByText('Test snapshot');

    expect(screen.getByText('Snaglet keeps the last 2 pre-update snapshots.')).toBeInTheDocument();
    expect(screen.queryByText(/Update checkpoints/)).toBeNull();
  });

  it('shows the count and size of the update checkpoints', async () => {
    api.preUpdateCheckpoints.mockResolvedValue({ count: 2, totalBytes: 3 * 1024 * 1024 });
    render(<DatabaseSettingsView />);

    expect(
      await screen.findByText(/Update checkpoints in backups\/pre-migration: 2 · 3 MB\./)
    ).toBeInTheDocument();
  });

  it('leaves the checkpoint line out when it cannot be read', async () => {
    api.preUpdateCheckpoints.mockRejectedValue(new Error('unreadable'));
    render(<DatabaseSettingsView />);
    await screen.findByText('Test snapshot');

    expect(screen.getByText(/Snaglet keeps the last 2 pre-update snapshots/)).toBeInTheDocument();
    expect(screen.queryByText(/Update checkpoints/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('DatabaseSettingsView — reset to a clean slate', () => {
  it('opens the launch panes and reads the tree again once the reset finishes', async () => {
    const events: LibraryEvent[] = [];
    const off = onLibraryEvent((event) => events.push(event));
    const user = userEvent.setup();
    api.reset.mockResolvedValue({ ...IDLE_JOB, running: true, kind: 'reset' });
    render(<DatabaseSettingsView />);
    await screen.findByText('Test snapshot');

    await user.click(screen.getByRole('button', { name: 'Reset to clean slate…' }));
    api.backupStatus.mockResolvedValue({ ...IDLE_JOB, kind: 'reset', requiresRestart: true });
    await user.click(screen.getByRole('button', { name: 'Wipe content' }));
    expect(api.reset).toHaveBeenCalledWith({ createBackup: true, scope: 'content' });
    // Nothing changes while the reset runs.
    expect(nav.reopenForNewContent).not.toHaveBeenCalled();

    await waitFor(() => expect(nav.reopenForNewContent).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    });
    expect(toast.showToast).toHaveBeenCalledWith(
      'Reset complete. Restart the app to load the new state cleanly.',
      { durationMs: 8000 }
    );
    expect(events).toContainEqual({ type: 'tree-invalidated', ids: [] });
    off();
  });

  it('keeps the panes when the reset fails', async () => {
    const user = userEvent.setup();
    api.reset.mockResolvedValue({ ...IDLE_JOB, running: true, kind: 'reset' });
    render(<DatabaseSettingsView />);
    await screen.findByText('Test snapshot');

    await user.click(screen.getByRole('button', { name: 'Reset to clean slate…' }));
    api.backupStatus.mockResolvedValue({ ...IDLE_JOB, kind: 'reset', error: 'disk full' });
    await user.click(screen.getByRole('button', { name: 'Wipe content' }));

    await waitFor(
      () =>
        expect(toast.showToast).toHaveBeenCalledWith('Reset failed: disk full', {
          durationMs: 6000,
        }),
      { timeout: 5000 }
    );
    expect(nav.reopenForNewContent).not.toHaveBeenCalled();
  });
});
