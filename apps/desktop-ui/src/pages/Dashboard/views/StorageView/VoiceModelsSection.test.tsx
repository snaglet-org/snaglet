/**
 * Choosing voices in Settings → Local storage: every catalog voice is listed
 * with its language, quality and size; the default voice is picked the first
 * time; Install selected shows the total download and installs exactly the
 * picked voices; each voice shows installing, failed (with Retry) and
 * installed states; an installed voice uninstalls at once with the space freed.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatBytes } from '@snaglet/shared/utils';
import type { VoiceInstallInfo, VoiceModelState } from '@desktop/utils/api';

vi.mock('@desktop/utils/api', () => ({
  LOCAL_MODELS_CHANGED_EVENT: 'snaglet:local-models-changed',
  snagletHomeApi: { voiceModels: { get: vi.fn(), install: vi.fn(), uninstall: vi.fn() } },
}));

import { snagletHomeApi } from '@desktop/utils/api';
import { VoiceModelsSection } from './VoiceModelsSection';

const voiceGet = vi.mocked(snagletHomeApi.voiceModels.get);
const voiceInstall = vi.mocked(snagletHomeApi.voiceModels.install);
const voiceUninstall = vi.mocked(snagletHomeApi.voiceModels.uninstall);

const AMY = 'en_US-amy-medium';
const RYAN = 'en_US-ryan-medium';
const ALAN = 'en_GB-alan-medium';
const BASE = 400_000_000;

const voice = (
  id: string,
  name: string,
  lang: string,
  downloadBytes: number,
  state: VoiceInstallInfo['state'] = 'not-installed',
  extra: Partial<VoiceInstallInfo> = {}
): VoiceInstallInfo => ({
  id,
  name,
  description: '',
  lang,
  quality: 'medium',
  downloadBytes,
  state,
  ...extra,
});

function status(
  states: Partial<Record<string, VoiceInstallInfo['state']>> = {},
  over: Partial<VoiceModelState> = {}
): VoiceModelState {
  return {
    state: 'not-installed',
    defaultVoiceId: AMY,
    baseMissingBytes: BASE,
    voices: [
      voice(AMY, 'Amy (US, warm)', 'en-US', 63_000_000, states[AMY]),
      voice(RYAN, 'Ryan (US, deep)', 'en-US', 62_000_000, states[RYAN]),
      voice(ALAN, 'Alan (UK)', 'en-GB', 61_000_000, states[ALAN]),
    ],
    ...over,
  };
}

const refreshStorage = vi.fn(async () => undefined);

function renderSection() {
  render(
    <VoiceModelsSection
      storage={{ categories: [], localModels: [], totalBytes: 0 }}
      refreshStorage={refreshStorage}
      removalUiEnabled
      onRemoveModel={vi.fn()}
      onEnableModel={vi.fn(async () => undefined)}
      modelBusy={null}
    />
  );
}

const row = (voiceId: string) =>
  screen
    .getByRole('list', { name: 'Voices' })
    .querySelector<HTMLElement>(`[data-voice-id="${voiceId}"]`)!;
const pill = (name: string) => screen.getByRole('button', { name, pressed: undefined });
const installButton = () => screen.getByRole('button', { name: /^Install selected/ });

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('VoiceModelsSection — choosing voices', () => {
  it('lists every voice and picks the default the first time, with the total download', async () => {
    voiceGet.mockResolvedValue(status());
    renderSection();

    expect(await screen.findByText('No voice installed')).toBeTruthy();
    expect(within(row(ALAN)).getByText(/British English · Medium quality/)).toBeTruthy();
    expect(within(row(AMY)).getByText(/American English · Medium quality/)).toBeTruthy();
    await waitFor(() =>
      expect(pill('Amy (US, warm) (default)')).toHaveAttribute('aria-pressed', 'true')
    );
    expect(pill('Ryan (US, deep)')).toHaveAttribute('aria-pressed', 'false');
    expect(installButton()).toHaveTextContent(
      `Install selected (1) · ${formatBytes(BASE + 63_000_000)}`
    );
  });

  it('totals the picked voices, and installs exactly those', async () => {
    voiceGet.mockResolvedValue(status());
    voiceInstall.mockResolvedValue(status({ [AMY]: 'installing', [ALAN]: 'installing' }));
    renderSection();
    await waitFor(() => expect(installButton()).toBeEnabled());

    fireEvent.click(pill('Alan (UK)'));
    expect(installButton()).toHaveTextContent(
      `Install selected (2) · ${formatBytes(BASE + 63_000_000 + 61_000_000)}`
    );
    fireEvent.click(installButton());

    await waitFor(() => expect(voiceInstall).toHaveBeenCalledWith([AMY, ALAN]));
  });

  it('cannot install with nothing picked', async () => {
    voiceGet.mockResolvedValue(status({ [AMY]: 'installed' }, { baseMissingBytes: 0 }));
    renderSection();
    expect(await screen.findByText('1 of 3 installed')).toBeTruthy();
    // A voice is installed, so the default is not picked for you.
    expect(pill('Ryan (US, deep)')).toHaveAttribute('aria-pressed', 'false');
    expect(installButton()).toBeDisabled();

    fireEvent.click(pill('Ryan (US, deep)'));
    expect(installButton()).toHaveTextContent(`Install selected (1) · ${formatBytes(62_000_000)}`);
    fireEvent.click(pill('Ryan (US, deep)'));
    expect(installButton()).toBeDisabled();
  });

  it('shows each voice installing with progress, then installed', async () => {
    voiceGet.mockResolvedValue(status());
    voiceInstall.mockResolvedValue(
      status({ [AMY]: 'installing' }, { state: 'downloading', percent: 40 })
    );
    const changed = vi.fn();
    window.addEventListener('snaglet:local-models-changed', changed);
    renderSection();
    await waitFor(() => expect(installButton()).toBeEnabled());

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(installButton());
    expect(await within(row(AMY)).findByText('Installing · 40%')).toBeTruthy();

    voiceGet.mockResolvedValue(status({ [AMY]: 'installed' }, { state: 'ready' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    await waitFor(() => expect(within(row(AMY)).getByText('Installed')).toBeTruthy());
    expect(refreshStorage).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
    window.removeEventListener('snaglet:local-models-changed', changed);
  });

  it('shows a failed voice with its error and retries just that voice', async () => {
    voiceGet.mockResolvedValue(
      status(
        {},
        {
          state: 'failed',
          voices: [
            voice(AMY, 'Amy (US, warm)', 'en-US', 63_000_000, 'installed'),
            voice(RYAN, 'Ryan (US, deep)', 'en-US', 62_000_000, 'failed', {
              error: "Couldn't reach the download server.",
            }),
          ],
        }
      )
    );
    voiceInstall.mockResolvedValue(status({ [RYAN]: 'installing' }, { state: 'downloading' }));
    renderSection();
    await screen.findByRole('list', { name: 'Voices' });

    expect(await within(row(RYAN)).findByText("Couldn't reach the download server.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Ryan (US, deep)' }));
    await waitFor(() => expect(voiceInstall).toHaveBeenCalledWith([RYAN]));
  });

  it('a failed install request marks the picked voices failed', async () => {
    voiceGet.mockResolvedValue(status());
    voiceInstall.mockRejectedValue(new Error('Another voice install is running.'));
    renderSection();
    await waitFor(() => expect(installButton()).toBeEnabled());

    fireEvent.click(installButton());
    expect(await within(row(AMY)).findByText('Another voice install is running.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry Amy (US, warm)' })).toBeTruthy();
  });
});

describe('VoiceModelsSection — uninstalling voices', () => {
  it('uninstalls at once, with no confirmation, and says how much space it freed', async () => {
    voiceGet.mockResolvedValue(status({ [AMY]: 'installed', [RYAN]: 'installed' }));
    voiceUninstall.mockResolvedValue(status({ [AMY]: 'installed' }, { freedBytes: 62_000_000 }));
    const changed = vi.fn();
    window.addEventListener('snaglet:local-models-changed', changed);
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall Ryan (US, deep)' }));

    await waitFor(() => expect(voiceUninstall).toHaveBeenCalledWith([RYAN]));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      await within(row(RYAN)).findByText(`Uninstalled · ${formatBytes(62_000_000)} freed`)
    ).toBeTruthy();
    // The row is offered again for install.
    expect(pill('Ryan (US, deep)')).toHaveAttribute('aria-pressed', 'false');
    expect(refreshStorage).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
    window.removeEventListener('snaglet:local-models-changed', changed);
  });

  it('uninstalls the default voice and the last voice too', async () => {
    voiceGet.mockResolvedValue(status({ [AMY]: 'installed' }));
    voiceUninstall.mockResolvedValue(status({}, { freedBytes: 63_000_000 }));
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall Amy (US, warm)' }));
    expect(await screen.findByText('No voice installed')).toBeTruthy();
    expect(voiceUninstall).toHaveBeenCalledWith([AMY]);
  });

  it('says inline when an uninstall fails', async () => {
    voiceGet.mockResolvedValue(status({ [AMY]: 'installed' }));
    voiceUninstall.mockRejectedValue(new Error('A voice install is running.'));
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall Amy (US, warm)' }));
    expect(await within(row(AMY)).findByText('A voice install is running.')).toBeTruthy();
    expect(within(row(AMY)).getByText('Installed')).toBeTruthy();
  });
});
