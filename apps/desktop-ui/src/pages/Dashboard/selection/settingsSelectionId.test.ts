import { describe, expect, it } from 'vitest';
import { settingsSelectionId } from './types';

describe('settingsSelectionId', () => {
  it('maps the Agents row to its instructions pane', () => {
    expect(settingsSelectionId({ kind: 'agent-instructions' })).toBe('agent-instructions');
  });

  it('distinguishes the Data rows', () => {
    expect(settingsSelectionId({ kind: 'embeddings', tab: 'embeddings' })).toBe('embeddings');
    expect(settingsSelectionId({ kind: 'embeddings', tab: 'backups' })).toBe('backups');
    expect(settingsSelectionId({ kind: 'embeddings' })).toBe('embeddings');
  });

  it('keeps provider surfaces out of the Settings activity tree', () => {
    expect(settingsSelectionId({ kind: 'providers' })).toBeNull();
    expect(
      settingsSelectionId({
        kind: 'provider',
        provider_id: 'anthropic',
        name: 'Anthropic',
        provider_type: 'llm',
      })
    ).toBeNull();
  });
});
