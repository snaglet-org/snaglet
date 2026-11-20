import { fetchJson, getApiUrl } from './core';

export const LOCAL_MODELS_CHANGED_EVENT = 'snaglet:local-models-changed';

export interface SnagletHomeState {
  active: string;
  override: string | null;
  saved: string[];
}

export interface SnagletStorageState {
  categories: Array<{
    key: string;
    path: string;
    bytes: number;
    removable: boolean;
    /** What the category's Clear button does (shown as its tooltip); null when it has none. */
    clearDescription: string | null;
  }>;
  localModels: SnagletVoiceStorageModel[];
  totalBytes: number;
}

export interface SnagletVoiceStorageModel {
  id: string;
  component: 'reranker' | 'stt' | 'vad' | 'tts' | 'shared';
  name: string;
  description: string;
  path: string;
  bytes: number;
  expectedBytes: number;
  installed: boolean;
  removable: boolean;
  disabled: boolean;
}

/** One voice mode's component needs for the active engine, and whether met. */
interface VoiceModeCapability {
  /** Components this mode needs ('stt' | 'vad' | 'tts'); empty = nothing to download. */
  needs: Array<'stt' | 'vad' | 'tts'>;
  /** Every needed component is present on disk (an empty need is always ready). */
  ready: boolean;
}

/**
 * Per-mode capability report for the engine actually in use. Lets each voice
 * toggle gate on only what that mode needs — e.g. on macOS, Dictation uses
 * Apple's on-device recognizer and needs no local model, so its `dictate.ready`
 * is true with nothing downloaded and the toggle never shows the model prompt.
 */
interface VoiceCapabilities {
  /** Active STT engine: 'apple' = macOS on-device recognizer, 'local' = bundled ONNX. */
  sttEngine: 'apple' | 'local';
  dictate: VoiceModeCapability;
  speak: VoiceModeCapability;
}

/** One catalog voice in Settings → Local storage, with its own install state. */
export interface VoiceInstallInfo {
  id: string;
  /** Catalog label, e.g. "Amy (US, warm)". */
  name: string;
  description: string;
  /** BCP-47 language tag, e.g. `en-US`. */
  lang: string;
  /** Piper quality tier, e.g. `medium`. */
  quality: string;
  /** Pinned download size of the voice's own files. */
  downloadBytes: number;
  state: 'installed' | 'not-installed' | 'installing' | 'failed';
  /** Why the voice's last install failed (state `failed`). */
  error?: string;
}

export interface VoiceModelState {
  state: 'not-installed' | 'downloading' | 'ready' | 'failed';
  /** Every catalog voice with its state, read from disk (status/install/uninstall responses). */
  voices?: VoiceInstallInfo[];
  /** The voice an agent without one speaks with; preselected when no voice is installed. */
  defaultVoiceId?: string;
  /** Pinned bytes of the base pieces (speech recognition, voice detection, shared voice data) not yet on disk. */
  baseMissingBytes?: number;
  /** Bytes an uninstall deleted (uninstall responses only). */
  freedBytes?: number;
  error?: string;
  /** Bytes downloaded so far this install (download in flight only). */
  receivedBytes?: number;
  /** Total pinned bytes for the install (download in flight only). */
  totalBytes?: number;
  /** Convenience 0–100 overall percent (download in flight only). */
  percent?: number;
  /** Pinned size of a full install, from the manifest — for the size text. */
  expectedTotalBytes?: number;
  /** Per-mode component needs for the active engine (status/install responses). */
  capabilities?: VoiceCapabilities;
}

export const snagletHomeApi = {
  storage: {
    get: () => fetchJson<SnagletStorageState>(getApiUrl('/snaglet-home/storage')),
    clear: (key: string) =>
      fetchJson<SnagletStorageState>(
        getApiUrl(`/snaglet-home/storage/${encodeURIComponent(key)}`),
        {
          method: 'DELETE',
        }
      ),
    clearLocalModel: (id: string) =>
      fetchJson<SnagletStorageState>(
        getApiUrl(`/snaglet-home/storage/local-models/${encodeURIComponent(id)}`),
        { method: 'DELETE' }
      ),
    enableLocalModel: (id: string) =>
      fetchJson<SnagletStorageState>(
        getApiUrl(`/snaglet-home/storage/local-models/${encodeURIComponent(id)}/enable`),
        { method: 'POST' }
      ),
  },
  voiceModels: {
    get: () => fetchJson<VoiceModelState>(getApiUrl('/voice/models/status')),
    /**
     * Install the base pieces plus `voiceIds` (an empty list: the base pieces
     * only). Without ids the server keeps the installed voices, or installs the
     * default voice.
     */
    install: (voiceIds?: string[]) =>
      fetchJson<VoiceModelState>(getApiUrl('/voice/models/install'), {
        method: 'POST',
        ...(voiceIds ? { body: JSON.stringify({ voiceIds }) } : {}),
      }),
    /** Delete these voices' files. The shared voice data and speech models stay. */
    uninstall: (voiceIds: string[]) =>
      fetchJson<VoiceModelState>(getApiUrl('/voice/models/uninstall'), {
        method: 'POST',
        body: JSON.stringify({ voiceIds }),
      }),
  },
  async get(): Promise<SnagletHomeState> {
    return fetchJson<SnagletHomeState>(getApiUrl('/snaglet-home'));
  },

  async setOverride(path: string): Promise<SnagletHomeState> {
    return fetchJson<SnagletHomeState>(getApiUrl('/snaglet-home/override'), {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  async clearOverride(): Promise<SnagletHomeState> {
    return fetchJson<SnagletHomeState>(getApiUrl('/snaglet-home/override'), {
      method: 'DELETE',
    });
  },

  async addSaved(path: string): Promise<SnagletHomeState> {
    return fetchJson<SnagletHomeState>(getApiUrl('/snaglet-home/saved'), {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  async removeSaved(path: string): Promise<SnagletHomeState> {
    return fetchJson<SnagletHomeState>(getApiUrl('/snaglet-home/saved'), {
      method: 'DELETE',
      body: JSON.stringify({ path }),
    });
  },
};
