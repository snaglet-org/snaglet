/**
 * StorageView (Settings → Storage) and the two backends it straddles: HTTP
 * (`snagletHomeApi`) for the home pointer, disk-usage report and per-category
 * clear, and the Tauri shell (`socketClient`) for restarting into a new home
 * and moving the home folder, which the server cannot do to itself. The
 * tests pin the exact method names, so a call to a missing method fails
 * loudly instead of leaving a dead button.
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageView } from './StorageView';
import { snagletHomeApi } from '@desktop/utils/api';
import { socketClient } from '@desktop/socket';

const featureFlagState = vi.hoisted(() => ({ enabled: true }));

vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlagGuard: () => ({
    enabled: featureFlagState.enabled,
    isEnabled: () => featureFlagState.enabled,
  }),
}));

// Mock the whole api barrel (it evaluates client config at module load, which
// throws under vitest) — mirrors the other settings-view tests.
vi.mock('@desktop/utils/api', () => ({
  snagletHomeApi: {
    get: vi.fn(),
    setOverride: vi.fn(),
    clearOverride: vi.fn(),
    addSaved: vi.fn(),
    removeSaved: vi.fn(),
    storage: {
      get: vi.fn(),
      clear: vi.fn(),
      clearLocalModel: vi.fn(),
      enableLocalModel: vi.fn(),
    },
    voiceModels: { get: vi.fn(), install: vi.fn() },
  },
}));

vi.mock('@desktop/socket/index', () => ({
  socketClient: {
    restartApp: vi.fn(),
    moveSnagletHome: vi.fn(),
    pickFolder: vi.fn(),
  },
}));

const home = vi.mocked(snagletHomeApi.get);
const setOverride = vi.mocked(snagletHomeApi.setOverride);
const clearOverride = vi.mocked(snagletHomeApi.clearOverride);
const addSaved = vi.mocked(snagletHomeApi.addSaved);
const removeSaved = vi.mocked(snagletHomeApi.removeSaved);
const storageGet = vi.mocked(snagletHomeApi.storage.get);
const storageClear = vi.mocked(snagletHomeApi.storage.clear);
const clearLocalModel = vi.mocked(snagletHomeApi.storage.clearLocalModel);
const enableLocalModel = vi.mocked(snagletHomeApi.storage.enableLocalModel);
const voiceGet = vi.mocked(snagletHomeApi.voiceModels.get);
const voiceInstall = vi.mocked(snagletHomeApi.voiceModels.install);
const restartApp = vi.mocked(socketClient.restartApp);
const moveSnagletHome = vi.mocked(socketClient.moveSnagletHome);
const pickFolder = vi.mocked(socketClient.pickFolder);

const HOME = { active: '/Users/me/.snaglet', override: null, saved: ['/Users/me/.snaglet-test'] };
const STORAGE = {
  categories: [
    {
      key: 'models',
      path: '/Users/me/.snaglet/models',
      bytes: 2048,
      removable: true,
      clearDescription: 'Deletes downloaded local models.',
    },
    {
      key: 'logs',
      path: '/Users/me/.snaglet/logs',
      bytes: 512,
      removable: true,
      clearDescription: "Deletes Snaglet's log files.",
    },
    {
      key: 'database',
      path: '/Users/me/.snaglet/db',
      bytes: 1024,
      removable: false,
      clearDescription: null,
    },
  ],
  localModels: [],
  totalBytes: 3072,
};

beforeEach(() => {
  vi.clearAllMocks();
  featureFlagState.enabled = true;
  home.mockResolvedValue(HOME);
  storageGet.mockResolvedValue(STORAGE);
  voiceGet.mockResolvedValue({ state: 'not-installed' });
  // Confirmations are in-app modals (the Tauri webview suppresses
  // window.confirm), so returning false here makes any native-dialog
  // dependency fail loudly.
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

async function renderSettled() {
  render(<StorageView />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Local storage' })).toBeTruthy());
}

function localModelRemoveButton(): HTMLButtonElement | undefined {
  return screen
    .queryAllByRole('button', { name: 'Remove' })
    .find((button) => !button.hasAttribute('title')) as HTMLButtonElement | undefined;
}

describe('StorageView — Snaglet home section', () => {
  it('renders the active home, its saved paths, and the disk report', async () => {
    await renderSettled();
    expect(screen.getByText('/Users/me/.snaglet')).toBeTruthy();
    expect(screen.getByText('/Users/me/.snaglet-test')).toBeTruthy();
    // Shared formatBytes renders 2048 B as "2 KB" and the total as "3 KB".
    await waitFor(() => expect(screen.getByText('3 KB')).toBeTruthy());
    expect(screen.getByText('2 KB')).toBeTruthy();
  });

  it('activates a saved path through setOverride and offers a restart via the in-app dialog', async () => {
    setOverride.mockResolvedValue({ ...HOME, override: '/Users/me/.snaglet-test' });
    await renderSettled();

    fireEvent.click(screen.getByTitle('Set as override (requires restart)'));

    await waitFor(() => expect(setOverride).toHaveBeenCalledWith('/Users/me/.snaglet-test'));
    // The restart runs only from the dialog's confirm button.
    expect(restartApp).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Restart Snaglet?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart now' }));
    await waitFor(() => expect(restartApp).toHaveBeenCalled());
  });

  it('declining the restart offer keeps the override applied without restarting', async () => {
    setOverride.mockResolvedValue({ ...HOME, override: '/Users/me/.snaglet-test' });
    await renderSettled();

    fireEvent.click(screen.getByTitle('Set as override (requires restart)'));
    const dialog = await screen.findByRole('dialog', { name: 'Restart Snaglet?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(setOverride).toHaveBeenCalledWith('/Users/me/.snaglet-test');
    expect(restartApp).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clears an active override through clearOverride', async () => {
    home.mockResolvedValue({ ...HOME, override: '/Users/me/.snaglet-test' });
    clearOverride.mockResolvedValue(HOME);
    await renderSettled();

    fireEvent.click(screen.getByRole('button', { name: 'Clear override' }));

    await waitFor(() => expect(clearOverride).toHaveBeenCalled());
    const dialog = await screen.findByRole('dialog', { name: 'Restart Snaglet?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart now' }));
    await waitFor(() => expect(restartApp).toHaveBeenCalled());
  });

  it('registers a typed path through addSaved and clears the input', async () => {
    addSaved.mockResolvedValue({ ...HOME, saved: ['/Users/me/.snaglet-new', ...HOME.saved] });
    await renderSettled();

    const input = screen.getByPlaceholderText('/Users/you/.snaglet-test');
    fireEvent.change(input, { target: { value: '  /Users/me/.snaglet-new  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    // Trimmed before it reaches the API.
    await waitFor(() => expect(addSaved).toHaveBeenCalledWith('/Users/me/.snaglet-new'));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
  });

  it('removes a saved path through removeSaved without restarting', async () => {
    removeSaved.mockResolvedValue({ ...HOME, saved: [] });
    await renderSettled();

    fireEvent.click(screen.getByTitle('Remove from registry'));

    await waitFor(() => expect(removeSaved).toHaveBeenCalledWith('/Users/me/.snaglet-test'));
    expect(restartApp).not.toHaveBeenCalled();
  });

  it('surfaces a failed home write inline instead of throwing', async () => {
    setOverride.mockRejectedValueOnce(new Error('path is not writable'));
    await renderSettled();

    fireEvent.click(screen.getByTitle('Set as override (requires restart)'));

    await waitFor(() => expect(screen.getByText('path is not writable')).toBeTruthy());
  });
});

describe('StorageView — move home', () => {
  it('picks a destination folder and hands it to the shell after the in-app confirmation', async () => {
    pickFolder.mockResolvedValue('/Volumes/ext/snaglet');
    await renderSettled();

    fireEvent.click(screen.getByRole('button', { name: 'Move this Snaglet home…' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Move this Snaglet home to /Volumes/ext/snaglet?',
    });
    expect(moveSnagletHome).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move and restart' }));
    await waitFor(() => expect(moveSnagletHome).toHaveBeenCalledWith('/Volumes/ext/snaglet'));
  });

  it('canceling the move confirmation never touches the shell', async () => {
    pickFolder.mockResolvedValue('/Volumes/ext/snaglet');
    await renderSettled();

    fireEvent.click(screen.getByRole('button', { name: 'Move this Snaglet home…' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Move this Snaglet home to /Volumes/ext/snaglet?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(moveSnagletHome).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when the folder picker cannot open', async () => {
    pickFolder.mockRejectedValue(new Error('shell bridge unavailable'));
    await renderSettled();

    fireEvent.click(screen.getByRole('button', { name: 'Move this Snaglet home…' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('shell bridge unavailable');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does nothing when the folder picker is dismissed', async () => {
    pickFolder.mockResolvedValue(null);
    await renderSettled();

    fireEvent.click(screen.getByRole('button', { name: 'Move this Snaglet home…' }));

    await waitFor(() => expect(pickFolder).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(moveSnagletHome).not.toHaveBeenCalled();
  });
});

describe('StorageView — storage categories and voice models', () => {
  it('clears only removable categories and refreshes the report', async () => {
    storageClear.mockResolvedValue({ ...STORAGE, localModels: [], totalBytes: 1024 });
    await renderSettled();
    await waitFor(() => expect(screen.getByText('models')).toBeTruthy());

    // `database` is not removable; models and logs are.
    const clears = screen.getAllByRole('button', { name: 'Clear' });
    expect(clears).toHaveLength(2);
    fireEvent.click(clears[0]);

    // The clear runs only from the dialog's confirm button.
    expect(storageClear).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Clear Snaglet models?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(storageClear).toHaveBeenCalledWith('models'));
  });

  it("gives every removable category's Clear button its own description", async () => {
    const categories = (['models', 'logs', 'build', 'temp'] as const).map((key) => ({
      key,
      path: `/Users/me/.snaglet/${key}`,
      bytes: 1024,
      removable: true,
      clearDescription: `What clearing ${key} does.`,
    }));
    storageGet.mockResolvedValue({
      ...STORAGE,
      categories: [...categories, STORAGE.categories[2]],
      totalBytes: 5120,
    });
    await renderSettled();
    await waitFor(() => expect(screen.getByText('temp')).toBeTruthy());

    const clears = screen.getAllByRole('button', { name: 'Clear' });
    expect(clears).toHaveLength(4);
    clears.forEach((button, i) => {
      fireEvent.focus(button);
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip.textContent).toBe(`What clearing ${categories[i].key} does.`);
      expect(button.getAttribute('aria-describedby')).toBe(tooltip.id);
      fireEvent.blur(button);
      expect(screen.queryByRole('tooltip')).toBeNull();
    });
  });

  it('says in the clear confirmation what clearing that category does', async () => {
    await renderSettled();
    await waitFor(() => expect(screen.getByText('logs')).toBeTruthy());

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear' })[1]);

    const dialog = await screen.findByRole('dialog', { name: 'Clear Snaglet logs?' });
    expect(within(dialog).getByText("Deletes Snaglet's log files.")).toBeTruthy();
  });

  it('canceling the clear confirmation leaves the category untouched', async () => {
    await renderSettled();
    await waitFor(() => expect(screen.getByText('models')).toBeTruthy());

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Clear Snaglet models?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(storageClear).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('removes a local model only after the in-app confirmation', async () => {
    voiceGet.mockResolvedValue({ state: 'ready' });
    storageGet.mockResolvedValue({
      ...STORAGE,
      localModels: [
        {
          id: 'tts:installed',
          component: 'tts',
          name: 'Installed voice',
          description: 'Installed',
          path: '/models/installed',
          bytes: 1024,
          expectedBytes: 1024,
          installed: true,
          removable: true,
          disabled: false,
        },
      ],
    });
    clearLocalModel.mockResolvedValue({ ...STORAGE, localModels: [] });
    await renderSettled();
    await waitFor(() => expect(screen.getByText('Installed voice')).toBeTruthy());
    const remove = localModelRemoveButton();
    if (!remove) throw new Error('expected local-model Remove control');

    fireEvent.click(remove);

    expect(clearLocalModel).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Remove Installed voice?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(clearLocalModel).toHaveBeenCalledWith('tts:installed'));
  });

  it('keeps every other Remove button and the reranker rows when ONE component is removed (voice state no longer "ready")', async () => {
    // With one component removed the status endpoint does not report
    // 'ready'; the per-component rows must still render from the storage
    // report, and the search reranker's rows must show too.
    voiceGet.mockResolvedValue({ state: 'not-installed' });
    storageGet.mockResolvedValue({
      ...STORAGE,
      localModels: [
        {
          id: 'reranker',
          component: 'reranker',
          name: 'Workspace reranker',
          description: 'Search ranking',
          path: '/models/reranker',
          bytes: 2048,
          expectedBytes: 2048,
          installed: true,
          removable: true,
          disabled: false,
        },
        {
          id: 'vad',
          component: 'vad',
          name: 'Voice detection',
          description: 'VAD',
          path: '/models/vad',
          bytes: 1024,
          expectedBytes: 1024,
          installed: true,
          removable: true,
          disabled: false,
        },
        {
          id: 'tts:amy',
          component: 'tts',
          name: 'Amy voice',
          description: 'TTS',
          path: '/models/tts',
          bytes: 0,
          expectedBytes: 4096,
          installed: false,
          removable: true,
          disabled: true, // the component that was removed
        },
      ],
    });
    await renderSettled();

    // Present components (reranker + VAD) each keep a Remove button even though
    // the global voice state is NOT 'ready'. Scope to the voice section so the
    // assertion ignores unrelated "Remove" controls (e.g. saved-path chips).
    await waitFor(() => expect(screen.getByText('Workspace reranker')).toBeTruthy());
    const section = screen.getByTestId('voice-models-section');
    expect(within(section).getByText('Voice detection')).toBeTruthy();
    expect(within(section).getAllByRole('button', { name: 'Remove' }).length).toBe(2);
    // The removed TTS component shows its "Enable and download" re-download row.
    expect(within(section).getByText('Amy voice')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Enable and download' })).toBeTruthy();
  });

  it('canceling the model removal keeps it installed', async () => {
    voiceGet.mockResolvedValue({ state: 'ready' });
    storageGet.mockResolvedValue({
      ...STORAGE,
      localModels: [
        {
          id: 'tts:installed',
          component: 'tts',
          name: 'Installed voice',
          description: 'Installed',
          path: '/models/installed',
          bytes: 1024,
          expectedBytes: 1024,
          installed: true,
          removable: true,
          disabled: false,
        },
      ],
    });
    await renderSettled();
    await waitFor(() => expect(screen.getByText('Installed voice')).toBeTruthy());
    const remove = localModelRemoveButton();
    if (!remove) throw new Error('expected local-model Remove control');

    fireEvent.click(remove);
    const dialog = await screen.findByRole('dialog', { name: 'Remove Installed voice?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(clearLocalModel).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Installed voice')).toBeTruthy();
  });

  it('keeps the download affordance but hides the removal rows when the removal flag is off', async () => {
    // The DOWNLOAD path is intentionally NOT behind the flag — a packaged-app
    // user must be able to install voice. Only the per-component Remove/Enable
    // rows are flag-gated.
    featureFlagState.enabled = false;
    voiceGet.mockResolvedValue({ state: 'ready' });
    storageGet.mockResolvedValue({
      ...STORAGE,
      localModels: [
        {
          id: 'tts:installed',
          component: 'tts',
          name: 'Installed voice',
          description: 'Installed',
          path: '/models/installed',
          bytes: 1024,
          expectedBytes: 1024,
          installed: true,
          removable: true,
          disabled: false,
        },
        {
          id: 'tts:disabled',
          component: 'tts',
          name: 'Disabled voice',
          description: 'Disabled',
          path: '/models/disabled',
          bytes: 0,
          expectedBytes: 1024,
          installed: false,
          removable: true,
          disabled: true,
        },
      ],
    });
    await renderSettled();

    // The voice-models section itself is always present (download lives here).
    expect(screen.getByText('Voice models')).toBeTruthy();
    // Installed per-component rows still render (informational), but with no
    // Remove button, and the disabled re-download row is hidden entirely.
    await waitFor(() => expect(screen.getByText('Installed voice')).toBeTruthy());
    expect(screen.queryByText('Disabled voice')).toBeNull();
    expect(localModelRemoveButton()).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Enable and download' })).toBeNull();
    // The models category Clear button is still flag-gated out → only logs.
    expect(screen.getAllByRole('button', { name: 'Clear' })).toHaveLength(1);
    expect(screen.getByText('logs')).toBeTruthy();
    // Install state is read regardless of the removal flag.
    expect(voiceGet).toHaveBeenCalled();
  });

  it('guards every retained local-model handler after the flag turns off', async () => {
    voiceGet.mockResolvedValue({ state: 'ready' });
    storageGet.mockResolvedValue({
      ...STORAGE,
      localModels: [
        {
          id: 'tts:installed',
          component: 'tts',
          name: 'Installed voice',
          description: 'Installed',
          path: '/models/installed',
          bytes: 1024,
          expectedBytes: 1024,
          installed: true,
          removable: true,
          disabled: false,
        },
        {
          id: 'tts:disabled',
          component: 'tts',
          name: 'Disabled voice',
          description: 'Disabled',
          path: '/models/disabled',
          bytes: 0,
          expectedBytes: 1024,
          installed: false,
          removable: true,
          disabled: true,
        },
      ],
    });
    await renderSettled();
    await waitFor(() => expect(screen.getByText('Installed voice')).toBeTruthy());
    const remove = localModelRemoveButton();
    if (!remove) throw new Error('expected local-model Remove control');
    const modelClear = screen.getAllByRole('button', { name: 'Clear' })[0];
    const enable = screen.getByRole('button', { name: 'Enable and download' });

    // Simulates stale DOM/keyboard callbacks retained from the enabled render.
    // The removal-flag-gated handlers (remove, clear models, enable) must still
    // guard; the download path is unaffected (not flag-gated).
    featureFlagState.enabled = false;
    fireEvent.click(remove);
    fireEvent.click(modelClear);
    fireEvent.click(enable);

    expect(clearLocalModel).not.toHaveBeenCalled();
    expect(storageClear).not.toHaveBeenCalled();
    expect(enableLocalModel).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    // The guards fire before the confirmation step, so no dialog opens either.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('downloads voice models on demand and refreshes storage after', async () => {
    voiceInstall.mockResolvedValue({ state: 'ready' });
    await renderSettled();

    fireEvent.click(screen.getByRole('button', { name: 'Download voice models' }));

    await waitFor(() => expect(voiceInstall).toHaveBeenCalled());
    // Freshly installed models change the on-disk size, so the report re-reads.
    await waitFor(() => expect(storageGet).toHaveBeenCalledTimes(2));
  });

  it('offers the download even when the removal flag is off', async () => {
    featureFlagState.enabled = false;
    voiceInstall.mockResolvedValue({ state: 'ready' });
    await renderSettled();

    fireEvent.click(screen.getByRole('button', { name: 'Download voice models' }));
    await waitFor(() => expect(voiceInstall).toHaveBeenCalled());
  });

  it('shows a retry affordance when the voice download failed', async () => {
    voiceInstall.mockRejectedValueOnce(new Error('checksum mismatch'));
    await renderSettled();

    fireEvent.click(screen.getByRole('button', { name: 'Download voice models' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry download' })).toBeTruthy()
    );
    expect(screen.getByText('checksum mismatch')).toBeTruthy();
  });
});

describe('StorageView — degradation', () => {
  it('explains a failed storage report instead of dropping the section silently', async () => {
    storageGet.mockRejectedValue(new Error('usage scan failed'));
    await renderSettled();

    expect(await screen.findByRole('alert')).toHaveTextContent('usage scan failed');
  });

  it('still renders the disk report when the home pointer fetch fails', async () => {
    home.mockRejectedValue(new Error('pointer unreadable'));
    await renderSettled();

    // The Snaglet-home section is hidden, but the pane settles rather than
    // parking on the loading hint forever.
    expect(screen.queryByText('Snaglet home directory')).toBeNull();
    await waitFor(() => expect(screen.getByText('3 KB')).toBeTruthy());
  });
});
