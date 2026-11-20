/**
 * AgentModelEditor — pins summary-model credential behavior: provider changes
 * select that provider's declared primary credential, cloud providers without
 * one cannot save, and manual/autosave paths persist the exact selected id.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModelEditor, type AgentModelEditorValue } from './AgentModelEditor';

const modelData = vi.hoisted(() => ({
  providers: [
    { id: 'p1', name: 'Prov One', type: 'llm', primaryCredentialId: 'cred-p1' },
    { id: 'p2', name: 'Prov Two', type: 'llm', primaryCredentialId: 'cred-p2' },
    { id: 'p3', name: 'Prov Three', type: 'llm', primaryCredentialId: null },
  ],
  models: [
    { id: 'row-m1', modelId: 'm1', providerId: 'p1', displayName: 'Model 1' },
    { id: 'row-m2', modelId: 'm2', providerId: 'p1', displayName: 'Model 2' },
    { id: 'row-p2', modelId: 'm-p2', providerId: 'p2', displayName: 'Model P2' },
    { id: 'row-p3', modelId: 'm-p3', providerId: 'p3', displayName: 'Model P3' },
    {
      id: 'row-m3',
      modelId: 'm3',
      providerId: 'p1',
      displayName: 'Model 3',
      metadata: { entitlement: { status: 'plan_blocked' } },
    },
  ],
  credentials: [
    { id: 'cred-p1', providerId: 'p1', label: 'Primary P1' },
    { id: 'cred-p2', providerId: 'p2', label: 'Primary P2' },
    { id: 'cred-p2-secondary', providerId: 'p2', label: 'Secondary P2' },
  ],
  loading: false,
}));

const refreshModelData = vi.hoisted(() => vi.fn());

vi.mock('@desktop/components/ModelSelector/ModelSelector.js', () => ({
  useModelData: () => modelData,
  refreshModelData,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const baseValue: AgentModelEditorValue = {
  providerId: 'p1',
  modelId: 'm1',
  credentialId: 'cred-p1',
  disableFallback: false,
};

describe('AgentModelEditor — autosave mode', () => {
  it('persists the exact selected credential with a model change', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    render(<AgentModelEditor value={baseValue} onSave={onSave} autosave />);

    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Model'), 'm2');

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      providerId: 'p1',
      modelId: 'm2',
      credentialId: 'cred-p1',
      disableFallback: false,
    });
  });

  it("selects the new provider's primary credential before the model is chosen", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    render(<AgentModelEditor value={baseValue} onSave={onSave} autosave />);

    await user.selectOptions(screen.getByLabelText('Provider'), 'p2');

    expect((screen.getByLabelText('Credential') as HTMLSelectElement).value).toBe('cred-p2');
    expect(onSave).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText('Model'), 'm-p2');
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'p2',
        modelId: 'm-p2',
        credentialId: 'cred-p2',
      })
    );
  });

  it('holds a credential change made before a model is chosen, then saves it with the model', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    render(<AgentModelEditor value={baseValue} onSave={onSave} autosave />);

    await user.selectOptions(screen.getByLabelText('Provider'), 'p2');
    await user.selectOptions(screen.getByLabelText('Credential'), 'cred-p2-secondary');

    // Saving here would persist `modelId: null` and leave the agent model-less.
    expect(onSave).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText('Model'), 'm-p2');
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      providerId: 'p2',
      modelId: 'm-p2',
      credentialId: 'cred-p2-secondary',
      disableFallback: false,
    });
  });

  it('saves a credential change right away when a model is already chosen', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    render(
      <AgentModelEditor
        value={{ providerId: 'p2', modelId: 'm-p2', credentialId: 'cred-p2' }}
        onSave={onSave}
        autosave
      />
    );

    await user.selectOptions(screen.getByLabelText('Credential'), 'cred-p2-secondary');

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      providerId: 'p2',
      modelId: 'm-p2',
      credentialId: 'cred-p2-secondary',
      disableFallback: false,
    });
  });

  it('blocks a cloud provider with no primary credential instead of borrowing another key', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    render(<AgentModelEditor value={baseValue} onSave={onSave} autosave />);

    await user.selectOptions(screen.getByLabelText('Provider'), 'p3');

    expect((screen.getByLabelText('Credential') as HTMLSelectElement).value).toBe('');
    expect(screen.getByLabelText('Model')).toBeDisabled();
    expect(screen.getByText(/Save a credential for this provider/)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps the pending selection and surfaces the error when a save fails', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {
      throw new Error('server said no');
    });
    render(<AgentModelEditor value={baseValue} onSave={onSave} autosave />);

    await user.selectOptions(screen.getByLabelText('Model'), 'm2');

    await waitFor(() => expect(screen.getByText('server said no')).toBeTruthy());
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('m2');
  });
});

describe('AgentModelEditor — plan-blocked model', () => {
  it('badges a plan-blocked model in the option label yet keeps it selectable', () => {
    render(<AgentModelEditor value={baseValue} onSave={vi.fn(async () => {})} />);

    const option = screen.getByRole('option', {
      name: /Model 3 — not on your plan/,
    }) as HTMLOptionElement;
    expect(option).toBeTruthy();
    expect(option.disabled).toBe(false);
    expect(screen.getByRole('option', { name: 'Model 2' })).toBeTruthy();
  });
});

describe('AgentModelEditor — inherited display (fallback + primary credential)', () => {
  it('displays the provider primary credential when no credential is pinned, badged "(primary)"', () => {
    render(
      <AgentModelEditor
        value={{ providerId: 'p1', modelId: 'm1', credentialId: null }}
        onSave={vi.fn(async () => {})}
        autosave
      />
    );

    const credentialSelect = screen.getByLabelText('Credential') as HTMLSelectElement;
    expect(credentialSelect.value).toBe('cred-p1');
    expect(screen.getByRole('option', { name: 'Primary P1 (primary)' })).toBeTruthy();
    // The primary default satisfies the required-credential gate: the model
    // select must stay usable instead of demanding a manual credential pick.
    expect(screen.getByLabelText('Model')).not.toBeDisabled();
  });

  it('prefills all three selects from the fallback when there is no override', () => {
    render(
      <AgentModelEditor
        value={{ providerId: null, modelId: null, credentialId: null }}
        fallback={{ providerId: 'p1', modelId: 'm1', credentialId: null }}
        onSave={vi.fn(async () => {})}
        allowNull
        autosave
      />
    );

    expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('p1');
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('m1');
    // Fallback carries no credential pin → the provider's primary shows.
    expect((screen.getByLabelText('Credential') as HTMLSelectElement).value).toBe('cred-p1');
    // Prefill is display-only: no persisted override → no Reset button.
    expect(screen.queryByRole('button', { name: /reset to default/i })).toBeNull();
  });

  it('"Reset to default" persists null but RENDERS the inherited fallback, not blank fields', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    render(
      <AgentModelEditor
        value={{ providerId: 'p2', modelId: 'm-p2', credentialId: 'cred-p2-secondary' }}
        fallback={{ providerId: 'p1', modelId: 'm1', credentialId: null }}
        onSave={onSave}
        allowNull
        autosave
      />
    );

    await user.click(screen.getByRole('button', { name: /reset to default/i }));

    // Persisted value is the inherit triple…
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        providerId: null,
        modelId: null,
        credentialId: null,
        disableFallback: false,
      })
    );
    // …while the selects display what the default resolves to.
    expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('p1');
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('m1');
    expect((screen.getByLabelText('Credential') as HTMLSelectElement).value).toBe('cred-p1');
  });

  it('reset renders the inherited values even when the override EQUALED the fallback', async () => {
    // value === fallback, so resetting never changes the baseline and no
    // reseed effect fires; the fields must still show the inherited values.
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    render(
      <AgentModelEditor
        value={{ providerId: 'p1', modelId: 'm1', credentialId: 'cred-p1' }}
        fallback={{ providerId: 'p1', modelId: 'm1', credentialId: 'cred-p1' }}
        onSave={onSave}
        allowNull
        autosave
      />
    );

    await user.click(screen.getByRole('button', { name: /reset to default/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('p1');
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('m1');
    expect((screen.getByLabelText('Credential') as HTMLSelectElement).value).toBe('cred-p1');
  });
});

describe('AgentModelEditor — manual mode', () => {
  it('persists the selected credential only when Save is clicked', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    render(<AgentModelEditor value={baseValue} onSave={onSave} />);

    const saveBtn = screen.getByRole('button', { name: /save/i });
    await user.selectOptions(screen.getByLabelText('Credential'), 'cred-p1');
    await user.selectOptions(screen.getByLabelText('Model'), 'm2');
    expect(onSave).not.toHaveBeenCalled();

    await user.click(saveBtn);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      providerId: 'p1',
      modelId: 'm2',
      credentialId: 'cred-p1',
      disableFallback: false,
    });
  });
});

describe('AgentModelEditor — model labels and a fresh list', () => {
  it('labels an alias and its dated snapshot apart and shows the snapshot an agent uses', () => {
    const saved = modelData.models;
    modelData.models = [
      {
        id: 'row-alias',
        modelId: 'claude-opus-4-5',
        providerId: 'anthropic',
        displayName: 'Claude Opus 4.5',
      },
      {
        id: 'row-dated',
        modelId: 'claude-opus-4-5-20251101',
        providerId: 'anthropic',
        displayName: 'Claude Opus 4.5',
      },
    ] as typeof saved;
    try {
      render(
        <AgentModelEditor
          value={{
            providerId: 'anthropic',
            modelId: 'claude-opus-4-5-20251101',
            credentialId: null,
          }}
          onSave={vi.fn(async () => {})}
        />
      );
      const select = screen.getByLabelText('Model') as HTMLSelectElement;
      expect([...select.options].map((option) => option.textContent)).toEqual([
        'Claude Opus 4.5',
        'Claude Opus 4.5 (20251101)',
      ]);
      expect(select.selectedOptions[0]?.textContent).toBe('Claude Opus 4.5 (20251101)');
    } finally {
      modelData.models = saved;
    }
  });

  it('reads the model list again when another provider is picked', async () => {
    const user = userEvent.setup();
    refreshModelData.mockClear();
    render(<AgentModelEditor value={baseValue} onSave={vi.fn(async () => {})} autosave />);

    await user.selectOptions(screen.getByLabelText('Provider'), 'p2');

    expect(refreshModelData).toHaveBeenCalled();
  });
});
