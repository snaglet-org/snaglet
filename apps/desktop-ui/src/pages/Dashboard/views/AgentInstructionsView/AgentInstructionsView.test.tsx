import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsRegistryRecord } from '@snaglet/shared/types';
import { AgentInstructionsView } from './AgentInstructionsView';
import { settingsApi } from '@desktop/utils/api';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    settingsApi: { registry: vi.fn(), put: vi.fn() },
  };
});

function registryRow(current: unknown): SettingsRegistryRecord {
  return {
    category: 'agent',
    key: 'global_instructions',
    description: 'Instructions for all agents.',
    valueType: 'string',
    default: '',
    current,
    isOverridden: current !== '',
    updatedAt: null,
    updatedBy: null,
  };
}

const otherRow: SettingsRegistryRecord = {
  ...registryRow(0),
  key: 'timeout_seconds',
  valueType: 'number',
  default: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(settingsApi.registry).mockResolvedValue([otherRow, registryRow('Keep replies short.')]);
  vi.mocked(settingsApi.put).mockResolvedValue(undefined);
});

describe('AgentInstructionsView', () => {
  it('loads the saved instructions with Save disabled until they change', async () => {
    render(<AgentInstructionsView />);

    const textarea = await screen.findByLabelText('Instructions');
    expect(textarea).toHaveValue('Keep replies short.');
    expect(screen.getByText('Added to every agent’s instructions, in every thread.')).toBeTruthy();
    expect(screen.getByText('19 / 8000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('enables Save on edit, saves the text, and shows Saved', async () => {
    const user = userEvent.setup();
    render(<AgentInstructionsView />);
    const textarea = await screen.findByLabelText('Instructions');

    await user.type(textarea, ' Ask first.');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();

    await user.click(save);

    expect(settingsApi.put).toHaveBeenCalledWith(
      'agent',
      'global_instructions',
      'Keep replies short. Ask first.'
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves with Cmd+S from the text box', async () => {
    render(<AgentInstructionsView />);
    const textarea = await screen.findByLabelText('Instructions');

    fireEvent.change(textarea, { target: { value: 'Use metric units.' } });
    fireEvent.keyDown(textarea, { key: 's', metaKey: true });

    await waitFor(() =>
      expect(settingsApi.put).toHaveBeenCalledWith(
        'agent',
        'global_instructions',
        'Use metric units.'
      )
    );
  });

  it('starts empty when nothing is saved yet', async () => {
    vi.mocked(settingsApi.registry).mockResolvedValue([registryRow('')]);
    render(<AgentInstructionsView />);

    expect(await screen.findByLabelText('Instructions')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows the error and keeps the edit when saving fails', async () => {
    vi.mocked(settingsApi.put).mockRejectedValue(new Error('Value does not match the schema'));
    render(<AgentInstructionsView />);
    const textarea = await screen.findByLabelText('Instructions');

    fireEvent.change(textarea, { target: { value: 'Use metric units.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Value does not match the schema');
    expect(textarea).toHaveValue('Use metric units.');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });
});
