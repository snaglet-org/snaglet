import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import type { ModelRow } from '@desktop/utils/api';
import { ModelsPanel } from './ModelsPanel';

const model = {
  id: 'model-row-1',
  providerId: 'anthropic',
  modelId: 'claude-sonnet-4',
  displayName: 'Claude Sonnet',
  description: '',
  metadata: {},
  sortOrder: 0,
} as ModelRow;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ModelsPanel focused model navigation', () => {
  it('centers the model card selected from the provider activity tree', () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const { container } = render(
      <ModelsPanel
        providerId="anthropic"
        models={[model]}
        usedModelIds={new Set()}
        focusModelId={model.id}
        onAddModel={vi.fn()}
        onUpdateModel={vi.fn()}
        onRemoveModel={vi.fn()}
        onDiscoverModels={vi.fn().mockResolvedValue({ providerId: 'anthropic', models: [] })}
        onImportModels={vi.fn()}
      />
    );

    expect(container.querySelector(`[data-model-id="${model.id}"]`)).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
  });
});

function renderCreation(providerId = 'anthropic') {
  const onAddModel = vi.fn().mockResolvedValue(true);
  const onDiscoverModels = vi.fn().mockResolvedValue({ providerId, models: [] });
  render(
    <ModelsPanel
      providerId={providerId}
      models={[]}
      usedModelIds={new Set()}
      onAddModel={onAddModel}
      onUpdateModel={vi.fn()}
      onRemoveModel={vi.fn()}
      onDiscoverModels={onDiscoverModels}
      onImportModels={vi.fn()}
    />
  );
  return { onAddModel, onDiscoverModels };
}

describe('ModelsPanel creation layout', () => {
  it.each([
    ['ollama', 'Model ID (e.g. llama3.2)'],
    ['lm-studio', 'Model ID (e.g. llama-3.2-3b-instruct)'],
    ['anthropic', 'Model ID (e.g. claude-sonnet-4-5)'],
  ])('suggests a model id in the form %s uses', (providerId, placeholder) => {
    renderCreation(providerId);
    expect(screen.getByRole('textbox', { name: 'Model ID' })).toHaveAttribute(
      'placeholder',
      placeholder
    );
  });

  it('keeps discovery before creation and preserves quick add by ID', () => {
    const { onAddModel } = renderCreation();
    const id = screen.getByRole('textbox', { name: 'Model ID' });
    const discover = screen.getByRole('button', { name: /Discover models/i });
    expect(discover.compareDocumentPosition(id) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add model' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.change(id, { target: { value: 'test-model' } });
    fireEvent.keyDown(id, { key: 'Enter' });
    expect(onAddModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'test-model' }));
  });

  it('groups all expanded fields and submits them with one action', async () => {
    const { onAddModel } = renderCreation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Model ID' }), {
      target: { value: 'custom-model' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add custom model/ }));
    const group = screen.getByRole('group', { name: 'Custom model details' });
    const fields = within(group);
    expect(fields.getByRole('textbox', { name: 'Model ID' })).toHaveValue('custom-model');
    expect(screen.getAllByRole('textbox', { name: 'Model ID' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Applies to the/)).not.toBeInTheDocument();
    fireEvent.change(fields.getByLabelText('Display name'), { target: { value: 'Custom model' } });
    fireEvent.change(fields.getByLabelText('Context window (tokens)'), {
      target: { value: '64000' },
    });
    fireEvent.change(fields.getByLabelText('Max output (tokens)'), { target: { value: '4000' } });
    fireEvent.change(fields.getByLabelText('Token budget ratio (0–1)'), {
      target: { value: '0.5' },
    });
    fireEvent.change(fields.getByLabelText('Tail messages (kept verbatim)'), {
      target: { value: '8' },
    });
    fireEvent.click(fields.getByRole('button', { name: 'Add model' }));
    expect(onAddModel).toHaveBeenCalledExactlyOnceWith({
      modelId: 'custom-model',
      displayName: 'Custom model',
      contextWindowTokens: 64000,
      maxOutputTokens: 4000,
      metadata: { contextCompression: { tokenBudgetRatio: 0.5, tailMessages: 8 } },
    });
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Custom model details' })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('textbox', { name: 'Model ID' })).toHaveValue('');
  });

  it('keeps the draft when toggling details and discovery never submits it', async () => {
    const { onAddModel, onDiscoverModels } = renderCreation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Model ID' }), {
      target: { value: 'draft-model' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add custom model/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add custom model/ }));
    expect(screen.getByRole('textbox', { name: 'Model ID' })).toHaveValue('draft-model');
    fireEvent.click(screen.getByRole('button', { name: /Discover models/i }));
    await waitFor(() => expect(onDiscoverModels).toHaveBeenCalledWith('anthropic'));
    expect(onAddModel).not.toHaveBeenCalled();
  });
});

describe('ModelsPanel refused saves', () => {
  function renderWith(handlers: {
    onAddModel?: (...a: unknown[]) => Promise<boolean>;
    onUpdateModel?: (...a: unknown[]) => Promise<boolean>;
  }) {
    render(
      <ModelsPanel
        providerId="anthropic"
        models={[model]}
        usedModelIds={new Set()}
        onAddModel={(handlers.onAddModel ?? vi.fn().mockResolvedValue(true)) as never}
        onUpdateModel={(handlers.onUpdateModel ?? vi.fn().mockResolvedValue(true)) as never}
        onRemoveModel={vi.fn()}
        onDiscoverModels={vi.fn().mockResolvedValue({ providerId: 'anthropic', models: [] })}
        onImportModels={vi.fn()}
      />
    );
  }

  it('keeps the typed model id when the add is refused', async () => {
    const onAddModel = vi.fn().mockResolvedValue(false);
    renderWith({ onAddModel });
    const id = screen.getByRole('textbox', { name: 'Model ID' });
    fireEvent.change(id, { target: { value: 'new-model' } });
    fireEvent.keyDown(id, { key: 'Enter' });

    await waitFor(() => expect(onAddModel).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('textbox', { name: 'Model ID' })).toHaveValue('new-model');
  });

  it('clears the form once the add is saved', async () => {
    const onAddModel = vi.fn().mockResolvedValue(true);
    renderWith({ onAddModel });
    const id = screen.getByRole('textbox', { name: 'Model ID' });
    fireEvent.change(id, { target: { value: 'new-model' } });
    fireEvent.keyDown(id, { key: 'Enter' });

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Model ID' })).toHaveValue(''));
  });

  it('keeps the edit open with its values when the update is refused', async () => {
    const onUpdateModel = vi.fn().mockResolvedValue(false);
    renderWith({ onUpdateModel });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByDisplayValue('Claude Sonnet'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdateModel).toHaveBeenCalledTimes(1));
    expect(screen.getByDisplayValue('Renamed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('closes the edit once the update is saved', async () => {
    const onUpdateModel = vi.fn().mockResolvedValue(true);
    renderWith({ onUpdateModel });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.queryByDisplayValue('Claude Sonnet')).not.toBeInTheDocument()
    );
  });
});
