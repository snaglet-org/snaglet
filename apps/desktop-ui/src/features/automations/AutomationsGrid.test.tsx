import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationRecord } from '@snaglet/shared/types';

const toast = vi.hoisted(() => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  undoResume: vi.fn(),
  undoPause: vi.fn(),
  runNow: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('@desktop/utils/api/automations', () => ({ automationsApi: api }));

const tables = vi.hoisted(() => ({ tablesApi: { updateEntry: vi.fn(), createEntry: vi.fn() } }));
vi.mock('@desktop/utils/api', () => tables);

import { FetchError } from '@desktop/utils/api/core';
import { AutomationsGrid } from './AutomationsGrid';
import { __resetAutomationsStoreForTests, loadAutomations } from './automationsStore';
import { automationRecord, DEFAULT_CALENDAR_ID, stubEditorLayout } from './testFixtures';

beforeAll(stubEditorLayout);

/** Active, on the Default calendar, its last run a success. */
const automation = (over: Partial<AutomationRecord> = {}): AutomationRecord =>
  automationRecord({
    calendarId: DEFAULT_CALENDAR_ID,
    calendarTitle: 'Default calendar',
    lastRun: {
      status: 'succeeded',
      scheduledFor: '2026-10-13T09:00:00.000Z',
      finishedAt: null,
      error: null,
    },
    ...over,
  });

/** Run the Undo action of the latest toast. */
function runUndo() {
  const calls = toast.showToast.mock.calls as Array<
    [string, { action?: { label: string; run: () => void } }?]
  >;
  const options = calls[calls.length - 1]?.[1];
  expect(options?.action?.label).toBe('Undo');
  options!.action!.run();
}

describe('AutomationsGrid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAutomationsStoreForTests();
    api.list.mockResolvedValue({ automations: [automation()] });
  });

  it('shows read-only cells: no inputs, the timing in words, the agent and the thread', async () => {
    render(<AutomationsGrid />);
    const row = (await screen.findByText('Morning check')).closest('tr')!;
    expect(within(row).queryByRole('textbox')).toBeNull();
    expect(within(row).getByText('every weekday at 9:00 AM')).toBeTruthy();
    expect(within(row).getByText('Test Agent A')).toBeTruthy();
    expect(within(row).getByText('Test thread')).toBeTruthy();
    expect(within(row).getByText('Ran')).toBeTruthy();
    expect(tables.tablesApi.updateEntry).not.toHaveBeenCalled();
  });

  it('pauses with Undo (resume) and archives with Undo (restore), no confirmation', async () => {
    api.pause.mockResolvedValue({
      automation: automation({ status: 'paused', pausedReason: 'user' }),
    });
    api.remove.mockResolvedValue({ automation: automation({ status: 'cancelled' }) });
    api.resume.mockResolvedValue({ automation: automation() });
    api.restore.mockResolvedValue({ automation: automation() });
    render(<AutomationsGrid />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(api.pause).toHaveBeenCalledWith('automation-1111111111111-aaaaaaaaa')
    );
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith('Paused Morning check', expect.anything())
    );
    runUndo();
    await waitFor(() => expect(api.resume).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(api.remove).toHaveBeenCalledWith('automation-1111111111111-aaaaaaaaa')
    );
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith('Archived Morning check', expect.anything())
    );
    runUndo();
    await waitFor(() =>
      expect(api.restore).toHaveBeenCalledWith('automation-1111111111111-aaaaaaaaa')
    );
    expect(api.resume).toHaveBeenCalledTimes(1);
  });

  describe('Undo of Resume', () => {
    const ID = 'automation-1111111111111-aaaaaaaaa';
    const FALLBACK = 'Paused Morning check (failure streak not restored)';

    /** Resume a row paused after failures; the server answers with `undoToken`. */
    async function resume(undoToken: string | null) {
      api.list.mockResolvedValue({
        automations: [
          automation({ status: 'paused', pausedReason: 'failures', consecutiveFailures: 3 }),
        ],
      });
      api.resume.mockResolvedValue({ automation: automation(), undoToken });
      api.pause.mockResolvedValue({
        automation: automation({ status: 'paused', pausedReason: 'user' }),
      });
      render(<AutomationsGrid />);
      fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
      await waitFor(() =>
        expect(toast.showToast).toHaveBeenCalledWith('Resumed Morning check', expect.anything())
      );
    }

    it('puts the pause back through the token, reason and streak included', async () => {
      api.undoResume.mockResolvedValue({
        automation: automation({
          status: 'paused',
          pausedReason: 'failures',
          consecutiveFailures: 3,
        }),
      });
      await resume('undo-token-1');
      runUndo();
      await waitFor(() => expect(api.undoResume).toHaveBeenCalledWith(ID, 'undo-token-1'));
      await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
      expect(api.pause).not.toHaveBeenCalled();
      expect(toast.showToast).not.toHaveBeenCalledWith(FALLBACK);
    });

    it('falls back to a plain pause, and says so, when the undo is refused (409)', async () => {
      api.undoResume.mockRejectedValue(
        new FetchError("Can't undo the resume: the undo expired.", 409)
      );
      await resume('undo-token-1');
      runUndo();
      await waitFor(() => expect(api.pause).toHaveBeenCalledWith(ID));
      expect(api.undoResume).toHaveBeenCalledWith(ID, 'undo-token-1');
      await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith(FALLBACK));
    });

    it('falls back to a plain pause when the resume gave no token', async () => {
      await resume(null);
      runUndo();
      await waitFor(() => expect(api.pause).toHaveBeenCalledWith(ID));
      expect(api.undoResume).not.toHaveBeenCalled();
      await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith(FALLBACK));
    });

    it('reports any other refusal instead of pausing', async () => {
      api.undoResume.mockRejectedValue(
        new FetchError('Only the person who resumed it can undo the resume.', 403)
      );
      await resume('undo-token-1');
      runUndo();
      await waitFor(() =>
        expect(toast.showToast).toHaveBeenCalledWith(
          'Only the person who resumed it can undo the resume.'
        )
      );
      expect(api.pause).not.toHaveBeenCalled();
    });
  });

  describe('Undo of Pause', () => {
    const ID = 'automation-1111111111111-aaaaaaaaa';
    const FALLBACK = 'Resumed Morning check (failure streak not restored)';
    const LIMIT_FULL = "Can't resume: 10 of 10 automations are active";
    const limitError = () =>
      new FetchError(
        'Test Agent A already has 10 active automations. Pause or cancel one first.',
        409,
        { reason: 'active_limit', active: 10, max: 10 }
      );

    /** Pause an active row with `streak` failures; the server answers with `undoToken`. */
    async function pause(undoToken: string | null, streak: number) {
      api.list.mockResolvedValue({ automations: [automation({ consecutiveFailures: streak })] });
      api.pause.mockResolvedValue({
        automation: automation({
          status: 'paused',
          pausedReason: 'user',
          consecutiveFailures: streak,
        }),
        undoToken,
      });
      api.resume.mockResolvedValue({ automation: automation(), undoToken: null });
      render(<AutomationsGrid />);
      fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
      await waitFor(() =>
        expect(toast.showToast).toHaveBeenCalledWith('Paused Morning check', expect.anything())
      );
    }

    it('resumes through the token, the failure streak kept', async () => {
      api.undoPause.mockResolvedValue({ automation: automation({ consecutiveFailures: 2 }) });
      await pause('undo-token-1', 2);
      runUndo();
      await waitFor(() => expect(api.undoPause).toHaveBeenCalledWith(ID, 'undo-token-1'));
      await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
      expect(api.resume).not.toHaveBeenCalled();
      expect(toast.showToast).not.toHaveBeenCalledWith(FALLBACK);
    });

    it('falls back to a plain resume, and says so, when the undo is refused (409)', async () => {
      api.undoPause.mockRejectedValue(
        new FetchError("Can't undo the pause: the undo expired.", 409)
      );
      await pause('undo-token-1', 2);
      runUndo();
      await waitFor(() => expect(api.resume).toHaveBeenCalledWith(ID));
      expect(api.undoPause).toHaveBeenCalledWith(ID, 'undo-token-1');
      await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith(FALLBACK));
    });

    it('falls back to a plain resume with no token; says so only when there was a streak', async () => {
      await pause(null, 0);
      runUndo();
      await waitFor(() => expect(api.resume).toHaveBeenCalledWith(ID));
      await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
      expect(api.undoPause).not.toHaveBeenCalled();
      expect(toast.showToast).not.toHaveBeenCalledWith(FALLBACK);
    });

    it('says the streak was not restored on a plain resume with no token after failures', async () => {
      await pause(null, 1);
      runUndo();
      await waitFor(() => expect(api.resume).toHaveBeenCalledWith(ID));
      await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith(FALLBACK));
    });

    it('names the active limit when the fallback resume is refused at it', async () => {
      api.undoPause.mockRejectedValue(
        new FetchError("Can't undo the pause: the automation changed since it was paused.", 409)
      );
      await pause('undo-token-1', 2);
      api.resume.mockRejectedValue(limitError());
      runUndo();
      await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith(LIMIT_FULL));
      expect(api.resume).toHaveBeenCalledWith(ID);
      expect(toast.showToast).not.toHaveBeenCalledWith(FALLBACK);
    });

    it('names the active limit when the undo itself is refused at it, without a plain resume', async () => {
      api.undoPause.mockRejectedValue(limitError());
      await pause('undo-token-1', 2);
      runUndo();
      await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith(LIMIT_FULL));
      expect(api.resume).not.toHaveBeenCalled();
    });

    it('reports any other refusal instead of resuming', async () => {
      api.undoPause.mockRejectedValue(
        new FetchError('Only the person who paused it can undo the pause.', 403)
      );
      await pause('undo-token-1', 2);
      runUndo();
      await waitFor(() =>
        expect(toast.showToast).toHaveBeenCalledWith(
          'Only the person who paused it can undo the pause.'
        )
      );
      expect(api.resume).not.toHaveBeenCalled();
    });
  });

  it('keeps a paused row paused when a read from before the pause lands late', async () => {
    render(<AutomationsGrid />);
    await screen.findByRole('button', { name: 'Pause' });
    let release!: () => void;
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ automations: [automation()] });
        })
    );
    api.list.mockResolvedValue({
      automations: [automation({ status: 'paused', pausedReason: 'user' })],
    });
    api.pause.mockResolvedValue({
      automation: automation({ status: 'paused', pausedReason: 'user' }),
    });
    // An automations:changed read is in flight when the pause lands.
    let read!: Promise<void>;
    act(() => {
      read = loadAutomations();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    await act(async () => {
      release();
      await read;
    });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it("hands focus to the row button that takes the pressed one's place", async () => {
    api.pause.mockResolvedValue({
      automation: automation({ status: 'paused', pausedReason: 'user' }),
    });
    render(<AutomationsGrid />);
    const pause = await screen.findByRole('button', { name: 'Pause' });
    pause.focus();
    fireEvent.click(pause);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume' })).toHaveFocus());
  });

  it('runs now and says who woke', async () => {
    api.runNow.mockResolvedValue({
      automation: automation(),
      run: { status: 'succeeded', error: null },
    });
    render(<AutomationsGrid />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('Woke Test Agent A'));
  });

  it('hides archived ones until asked, and restores one', async () => {
    api.list.mockResolvedValue({
      automations: [
        automation(),
        automation({ id: 'automation-2', name: 'Old one', status: 'cancelled' }),
      ],
    });
    api.restore.mockResolvedValue({
      automation: automation({ id: 'automation-2', name: 'Old one' }),
    });
    render(<AutomationsGrid />);
    await screen.findByText('Morning check');
    expect(screen.queryByText('Old one')).toBeNull();
    fireEvent.click(screen.getByText(/Show archived/));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    // The restore route changes only a deleted one: a stale row never resumes a paused one.
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith('automation-2'));
    expect(api.resume).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('Restored Old one'));
  });

  it('edits through the automation API, never the table writer', async () => {
    api.update.mockResolvedValue({ automation: automation({ name: 'Renamed' }) });
    render(<AutomationsGrid />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith('automation-1111111111111-aaaaaaaaa', {
        name: 'Renamed',
      })
    );
    expect(tables.tablesApi.updateEntry).not.toHaveBeenCalled();
    expect(await screen.findByText('Renamed')).toBeTruthy();
  });
});
