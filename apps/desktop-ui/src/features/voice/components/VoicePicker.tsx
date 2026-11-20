// Voice picker for the agent detail page (AgentView). A Select over the voice
// catalog fetched from GET /api/voice/capabilities (piper + installed Apple
// on-device voices), grouped by engine and badged with the quality tier so
// premium/enhanced Apple voices read as "needs a System-Settings download".
// Falls back to the built-in piper catalog when the request fails, and disables
// the preview button when /api/voice/preview answers 404. Persists via the
// caller's onSave. Theme tokens only.

import { useCallback, useEffect, useMemo, useState, type FC, type CSSProperties } from 'react';
import { Button, Select } from '@desktop/components';
import { getApiUrl } from '@desktop/utils/api/core';
import { LOCAL_MODELS_CHANGED_EVENT } from '@desktop/utils/api/snagletHome';
import { getErrorMessage } from '@snaglet/shared/utils';
import { voicePreviewError } from '../voicePreviewError';
import { playOneShot } from '../audio/playOneShot';
import {
  DEFAULT_VOICE_ID,
  VOICE_CAPABILITIES_PATH,
  VOICE_CATALOG,
  VOICE_PREVIEW_PATH,
  VOICE_PREVIEW_SENTENCE,
  type VoiceCapability,
} from '../voiceConstants';

export interface VoicePickerProps {
  /** Current agent.voice, or null/undefined to use the default. */
  value: string | null | undefined;
  /** Persist the new voice id (agentsApi.update under the hood). */
  onSave: (voiceId: string) => Promise<void> | void;
}

// Fallback list when the capabilities request fails: the built-in piper
// catalog, all bare ids, which the server routes to the piper engine.
const FALLBACK_VOICES: VoiceCapability[] = VOICE_CATALOG.map((v) => ({
  id: v.id,
  engine: 'piper',
  name: v.description ? `${v.label} — ${v.description}` : v.label,
  quality: 'standard',
  lang: 'en',
}));

/** Apple tier → picker badge. Piper's bundled voices ('standard') get no badge. */
const QUALITY_BADGE: Record<VoiceCapability['quality'], string> = {
  standard: '',
  default: 'Compact',
  enhanced: 'Enhanced',
  premium: 'Premium',
};

function optionLabel(v: VoiceCapability): string {
  const badge = QUALITY_BADGE[v.quality];
  const tier = badge ? ` · ${badge}` : '';
  const isDefault = v.id === DEFAULT_VOICE_ID ? ' (default)' : '';
  return `${v.name}${tier}${isDefault}`;
}

const wrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.5rem' };
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.5rem' };

export const VoicePicker: FC<VoicePickerProps> = ({ value, onSave }) => {
  const current = value ?? DEFAULT_VOICE_ID;
  const [voices, setVoices] = useState<VoiceCapability[]>(FALLBACK_VOICES);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshVoices = useCallback(async (canceled?: { current: boolean }) => {
    try {
      const res = await fetch(getApiUrl(VOICE_CAPABILITIES_PATH));
      if (!res.ok) return;
      const body = (await res.json()) as { voices?: VoiceCapability[] };
      if (!canceled?.current && Array.isArray(body.voices)) setVoices(body.voices);
    } catch {
      // Request failed: keep the fallback list.
    }
  }, []);

  // Refresh an already-open picker when a local voice is removed or restored.
  useEffect(() => {
    const canceled = { current: false };
    void refreshVoices(canceled);
    const handleModelsChanged = () => void refreshVoices();
    window.addEventListener(LOCAL_MODELS_CHANGED_EVENT, handleModelsChanged);
    return () => {
      canceled.current = true;
      window.removeEventListener(LOCAL_MODELS_CHANGED_EVENT, handleModelsChanged);
    };
  }, [refreshVoices]);

  // Never synthesize a removed local voice back into the picker.
  const options = useMemo<VoiceCapability[]>(() => voices, [voices]);
  const selectedVoiceId = options.some((v) => v.id === current) ? current : (options[0]?.id ?? '');

  const piperVoices = options.filter((v) => v.engine === 'piper');
  const appleVoices = options.filter((v) => v.engine === 'apple');

  const handleChange = useCallback(
    async (voiceId: string) => {
      setSaving(true);
      setError(null);
      try {
        await onSave(voiceId);
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to save voice'));
      } finally {
        setSaving(false);
      }
    },
    [onSave]
  );

  const handlePreview = useCallback(async () => {
    setPreviewing(true);
    setError(null);
    try {
      const res = await fetch(getApiUrl(VOICE_PREVIEW_PATH), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: selectedVoiceId, text: VOICE_PREVIEW_SENTENCE }),
      });
      if (res.status === 404) {
        setPreviewUnavailable(true);
        return;
      }
      if (!res.ok) throw new Error(await voicePreviewError(res, selectedVoiceId));
      // No stop handle needed here — the preview button doesn't support
      // cutting playback short, so the onEnded callback is a no-op.
      await playOneShot(await res.arrayBuffer(), () => {});
    } catch (err) {
      setError(getErrorMessage(err, 'Preview failed'));
    } finally {
      setPreviewing(false);
    }
  }, [selectedVoiceId]);

  return (
    <div style={wrap} data-testid="voice-picker">
      <div style={row}>
        <Select
          size="sm"
          value={selectedVoiceId}
          disabled={saving}
          aria-label="Agent voice"
          title={`Spoken when voice mode is on. Agents with no voice set use ${DEFAULT_VOICE_ID}.`}
          onChange={(e) => void handleChange(e.target.value)}
        >
          <optgroup label="Bundled (piper)">
            {piperVoices.map((v) => (
              <option key={v.id} value={v.id}>
                {optionLabel(v)}
              </option>
            ))}
          </optgroup>
          {appleVoices.length > 0 && (
            <optgroup label="Apple on-device">
              {appleVoices.map((v) => (
                <option key={v.id} value={v.id}>
                  {optionLabel(v)}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
        <Button
          variant="neutral"
          size="sm"
          onClick={() => void handlePreview()}
          loading={previewing}
          loadingText="Playing…"
          disabled={previewUnavailable || previewing || saving}
          title={
            previewUnavailable ? 'voice server not ready' : `Play a sample in ${selectedVoiceId}`
          }
        >
          ▶ Preview
        </Button>
      </div>
      {error && (
        <div role="alert" style={{ fontSize: '0.78rem', color: 'var(--color-error)' }}>
          {error}
        </div>
      )}
    </div>
  );
};
