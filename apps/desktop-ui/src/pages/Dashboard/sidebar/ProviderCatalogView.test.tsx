import { checkSidebarDisclosures } from '@desktop/test/sidebarDisclosure';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelRow, Provider } from '@desktop/utils/api';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import { getActiveDragChip, setActiveDragChip } from '@desktop/utils/nodeChip/payload';

const catalog = vi.hoisted(() => ({
  providers: [] as Provider[],
  models: [] as ModelRow[],
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
}));

vi.mock('../views/ProvidersView/ProviderCatalogContext', () => ({
  useProviderCatalog: () => catalog,
}));

import { ProviderCatalogView } from './ProviderCatalogView';

const anthropic = {
  id: 'anthropic',
  name: 'Anthropic',
  type: 'llm',
  sortOrder: 10,
} as Provider;

const github = {
  id: 'github',
  name: 'GitHub',
  type: 'integration',
  sortOrder: 20,
} as Provider;

const sonnet = {
  id: 'model-row-1',
  providerId: 'anthropic',
  modelId: 'claude-sonnet-4:latest',
  displayName: 'Claude Sonnet',
  sortOrder: 10,
} as ModelRow;

function fakeDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    get types() {
      return [...values.keys()];
    },
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? '',
    setDragImage: vi.fn(),
    effectAllowed: 'uninitialized',
  } as unknown as DataTransfer;
}

beforeEach(() => {
  catalog.providers = [anthropic, github];
  catalog.models = [sonnet];
  catalog.loading = false;
  catalog.error = null;
  setActiveDragChip(null);
});

describe('ProviderCatalogView', () => {
  it('groups providers by type and opens a provider pane', async () => {
    const user = userEvent.setup();
    const onProviderOpen = vi.fn();
    render(<ProviderCatalogView onProviderOpen={onProviderOpen} />);

    expect(screen.getByRole('button', { name: /LLM/i })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Integrations/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    await user.click(screen.getByRole('button', { name: /Anthropic/i }));
    expect(onProviderOpen).toHaveBeenCalledWith(anthropic);
  });

  it('expands a provider, opens its selected model, and exposes the active row', async () => {
    const user = userEvent.setup();
    const onProviderOpen = vi.fn();
    render(
      <ProviderCatalogView
        onProviderOpen={onProviderOpen}
        activeProviderId="anthropic"
        activeModelId={sonnet.id}
      />
    );

    const modelLabel = await screen.findByText('Claude Sonnet');
    const visibleRow = modelLabel.closest('[aria-selected="true"]');
    expect(visibleRow).not.toBeNull();
    await user.click(visibleRow!);
    expect(onProviderOpen).toHaveBeenCalledWith(anthropic, sonnet);
  });

  it('drags a model as both a model chip and a provider-pane selection', async () => {
    const user = userEvent.setup();
    render(<ProviderCatalogView onProviderOpen={vi.fn()} />);
    await user.click(screen.getByLabelText('Expand Anthropic models'));

    const modelRow = screen.getByText('Claude Sonnet').closest('[draggable="true"]');
    expect(modelRow).not.toBeNull();
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(modelRow!, { dataTransfer });

    expect(getActiveDragChip()).toEqual({
      id: sonnet.modelId,
      kind: 'model',
      title: sonnet.displayName,
    });
    expect(JSON.parse(dataTransfer.getData(PANE_ITEM_MIME))).toMatchObject({
      kind: 'provider',
      provider_id: anthropic.id,
      focusModelId: sonnet.id,
    });
  });
});

it('native sidebar disclosure affects sections/models only, not provider selection', async () => {
  const open = vi.fn();
  const view = render(<ProviderCatalogView onProviderOpen={open} />);
  await checkSidebarDisclosures(view.container, 'providers');
  expect(open).not.toHaveBeenCalled();
});
