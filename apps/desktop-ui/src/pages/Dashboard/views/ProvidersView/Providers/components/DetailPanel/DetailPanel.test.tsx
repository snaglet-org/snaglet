import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  Provider,
  ProviderAuthType,
  ProviderCredential,
  ProviderFallbackCredential,
} from '@desktop/utils/api';
import type { CredentialDraft } from '../../types';
import { getKeyAuthTypes } from '../../utils';
import { DetailPanel, type ConnectVia } from './DetailPanel';

const featureFlagState = vi.hoisted(() => ({ fallbackCredentials: false }));

vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlag: (name: string) =>
    name === 'fallback_credentials' ? featureFlagState.fallbackCredentials : false,
}));

beforeEach(() => {
  featureFlagState.fallbackCredentials = false;
});

vi.mock('../CopilotDeviceFlow/CopilotDeviceFlow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../CopilotDeviceFlow/CopilotDeviceFlow')>()),
  CopilotDeviceFlow: ({
    onToken,
    autoStart,
  }: {
    onToken: (token: string) => void;
    autoStart?: boolean;
  }) => (
    <div data-testid="github-device-flow" data-auto-start={String(Boolean(autoStart))}>
      <button type="button" onClick={() => onToken('gho_device_token')}>
        Complete GitHub auth
      </button>
    </div>
  ),
}));

const provider = {
  id: 'anthropic',
  name: 'Anthropic',
  type: 'llm',
  website: null,
  baseUrl: null,
  primaryCredentialId: null,
  authTypes: [{ id: 'api-key', name: 'API Key', type: 'api_key', sortOrder: 0 }],
} as Provider;

const unassignedCredential = {
  id: 'credential-other',
  providerId: provider.id,
  authTypeId: 'api-key',
  authType: 'api_key',
  label: 'Not in rotation key',
  hasSecret: true,
  updatedAt: '2026-07-29T12:00:00.000Z',
  verificationStatus: 'ok',
} as ProviderCredential;

const draft: CredentialDraft = {
  authTypeId: 'api-key',
  label: '',
  secret: '',
  metadata: {},
  pasteMode: false,
  jsonPaste: '',
  jsonError: null,
};

function fakeDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    get types() {
      return [...values.keys()];
    },
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? '',
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

function renderPanel({
  panelProvider = provider,
  credentials = [unassignedCredential],
  panelFallbacks = [],
  onMoveCredential = vi.fn().mockResolvedValue(undefined),
  onImportCli,
  onStartClaudeCodeLogin,
  connectVia,
  error = null,
}: {
  connectVia?: ConnectVia;
  error?: string | null;
  panelProvider?: Provider;
  credentials?: ProviderCredential[];
  panelFallbacks?: ProviderFallbackCredential[];
  onMoveCredential?: ReturnType<typeof vi.fn>;
  onImportCli?: () => void;
  onStartClaudeCodeLogin?: () => void;
} = {}) {
  const rendered = render(
    <DetailPanel
      provider={panelProvider}
      providerCredentials={credentials}
      fallbacks={panelFallbacks}
      models={[]}
      usedModelIds={new Set()}
      draft={draft}
      selectedAuthType={panelProvider.authTypes[0]}
      multiField={false}
      verify={{ status: 'idle', message: '' }}
      isTesting={false}
      isSaving={false}
      error={error}
      retestStates={{}}
      onPatchDraft={vi.fn()}
      onApplyJsonPaste={vi.fn()}
      onTest={vi.fn()}
      onSave={vi.fn()}
      onImportCli={onImportCli}
      onStartClaudeCodeLogin={onStartClaudeCodeLogin}
      onCancelClaudeCodeLogin={vi.fn()}
      onRetest={vi.fn()}
      onDelete={vi.fn()}
      onMoveCredential={onMoveCredential}
      onEditCredential={vi.fn()}
      onAddModel={vi.fn()}
      onUpdateModel={vi.fn()}
      onRemoveModel={vi.fn()}
      onDiscoverModels={vi.fn().mockResolvedValue({ providerId: panelProvider.id, models: [] })}
      onImportModels={vi.fn()}
      connectVia={connectVia}
    />
  );

  return { ...rendered, onMoveCredential };
}

const primaryCredential = {
  ...unassignedCredential,
  id: 'credential-primary',
  label: 'Primary key',
};
const fallbackCredential = {
  ...unassignedCredential,
  id: 'credential-fallback',
  label: 'Fallback key',
};
const rotationProvider = {
  ...provider,
  primaryCredentialId: primaryCredential.id,
};
const rotationFallbacks = [
  {
    id: 'fallback-row',
    providerId: provider.id,
    credentialId: fallbackCredential.id,
    fallbackIndex: 0,
    createdAt: '2026-07-29T12:00:00.000Z',
  },
];

function renderRotationPanel(onMoveCredential = vi.fn().mockResolvedValue(undefined)) {
  return renderPanel({
    panelProvider: rotationProvider,
    credentials: [primaryCredential, fallbackCredential, unassignedCredential],
    panelFallbacks: rotationFallbacks,
    onMoveCredential,
  });
}

function credentialRow(credentialId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-credential-id="${credentialId}"]`);
  expect(row).not.toBeNull();
  return row!;
}

const ROTATION_BUTTONS = ['Make primary', 'Make fallback', 'Not in rotation'];

describe('DetailPanel credential roles (fallback_credentials on)', () => {
  beforeEach(() => {
    featureFlagState.fallbackCredentials = true;
  });

  it('moves an unassigned credential to primary by drag and drop', () => {
    const onMoveCredential = vi.fn().mockResolvedValue(undefined);
    const { container } = renderPanel({ onMoveCredential });

    const source = screen
      .getByText(unassignedCredential.label)
      .closest('[data-credential-id="credential-other"]');
    const primaryZone = container.querySelector('[data-credential-zone="primary"]');
    expect(source).not.toBeNull();
    expect(primaryZone).not.toBeNull();

    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(source!, { dataTransfer });
    fireEvent.dragOver(primaryZone!, { dataTransfer });
    fireEvent.drop(primaryZone!, { dataTransfer });

    expect(onMoveCredential).toHaveBeenCalledWith(unassignedCredential.id, 'other', 'primary');
  });

  it('offers every rotation role on every credential row', () => {
    const onMoveCredential = vi.fn().mockResolvedValue(undefined);
    renderRotationPanel(onMoveCredential);

    const primaryRow = screen
      .getByText(primaryCredential.label)
      .closest<HTMLElement>('[data-credential-id="credential-primary"]');
    const fallbackRow = screen
      .getByText(fallbackCredential.label)
      .closest<HTMLElement>('[data-credential-id="credential-fallback"]');
    const otherRow = screen
      .getByText(unassignedCredential.label)
      .closest<HTMLElement>('[data-credential-id="credential-other"]');

    expect(primaryRow).not.toBeNull();
    expect(fallbackRow).not.toBeNull();
    expect(otherRow).not.toBeNull();

    for (const row of [primaryRow!, fallbackRow!, otherRow!]) {
      expect(within(row).getByRole('button', { name: 'Make primary' })).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Make fallback' })).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Not in rotation' })).toBeInTheDocument();
    }

    expect(within(primaryRow!).getByRole('button', { name: 'Make primary' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(fallbackRow!).getByRole('button', { name: 'Make fallback' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(otherRow!).getByRole('button', { name: 'Not in rotation' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.click(within(primaryRow!).getByRole('button', { name: 'Make fallback' }));
    fireEvent.click(within(fallbackRow!).getByRole('button', { name: 'Not in rotation' }));
    fireEvent.click(within(otherRow!).getByRole('button', { name: 'Make primary' }));

    expect(onMoveCredential).toHaveBeenCalledWith(primaryCredential.id, 'primary', 'fallback');
    expect(onMoveCredential).toHaveBeenCalledWith(fallbackCredential.id, 'fallback', 'other');
    expect(onMoveCredential).toHaveBeenCalledWith(unassignedCredential.id, 'other', 'primary');
  });

  it('shows the role badges, drag grips and the Not in rotation group label', () => {
    const { container } = renderRotationPanel();

    expect(within(credentialRow('credential-primary')).getByText('Primary')).toBeInTheDocument();
    expect(
      within(credentialRow('credential-fallback')).getByText('Fallback #1')
    ).toBeInTheDocument();
    for (const id of ['credential-primary', 'credential-fallback', 'credential-other']) {
      const row = credentialRow(id);
      expect(within(row).getByLabelText(/to change its role/)).toBeInTheDocument();
      expect(row).toHaveAttribute('draggable', 'true');
    }
    expect(container.querySelectorAll('[data-credential-zone]')).toHaveLength(3);
    expect(screen.getByText('Not in rotation', { selector: 'div' })).toBeInTheDocument();
  });
});

describe('DetailPanel credential list (fallback_credentials off, the default)', () => {
  it('lists every key once as a plain row with no rotation UI', () => {
    const onMoveCredential = vi.fn().mockResolvedValue(undefined);
    const { container } = renderRotationPanel(onMoveCredential);

    for (const cred of [primaryCredential, fallbackCredential, unassignedCredential]) {
      expect(screen.getAllByText(cred.label)).toHaveLength(1);
      const row = credentialRow(cred.id);
      expect(within(row).getByText('Verified')).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Retest' })).toBeInTheDocument();
      for (const name of ROTATION_BUTTONS) {
        expect(within(row).queryByRole('button', { name })).not.toBeInTheDocument();
      }
      expect(within(row).queryByLabelText(/to change its role/)).not.toBeInTheDocument();
      expect(row).toHaveAttribute('draggable', 'false');
    }

    expect(screen.queryByText('Primary')).not.toBeInTheDocument();
    expect(screen.queryByText(/Fallback #/)).not.toBeInTheDocument();
    expect(screen.queryByText('Rotation')).not.toBeInTheDocument();
    expect(screen.queryByText('Not in rotation')).not.toBeInTheDocument();
    expect(screen.queryByText(/Drop here/)).not.toBeInTheDocument();
    expect(container.querySelector('[data-credential-zone]')).toBeNull();
    expect(container.querySelector('[data-dragging]')).toBeNull();

    fireEvent.dragStart(credentialRow('credential-other'), { dataTransfer: fakeDataTransfer() });
    expect(screen.queryByText(/Drop here/)).not.toBeInTheDocument();
    expect(onMoveCredential).not.toHaveBeenCalled();
  });
});

describe('DetailPanel CLI sign-in entry points', () => {
  it('renders the Claude Code sign-in flow for Anthropic instead of the CLI import button', () => {
    const onStartClaudeCodeLogin = vi.fn();
    renderPanel({ onStartClaudeCodeLogin });

    const signIn = screen.getByRole('button', { name: 'Sign in with Claude Code' });
    expect(screen.queryByRole('button', { name: /Use local CLI login/ })).not.toBeInTheDocument();

    const addKey = screen.getByRole('button', { name: '+ Add key' });
    expect(addKey.parentElement).toContainElement(signIn);
    fireEvent.click(signIn);
    expect(onStartClaudeCodeLogin).toHaveBeenCalledTimes(1);
  });

  it('keeps the local CLI import button for Codex', () => {
    const onImportCli = vi.fn();
    const codex = {
      ...provider,
      id: 'codex',
      name: 'Codex',
      authTypes: [{ id: 'codex:api-key', name: 'API Key', type: 'api_key', sortOrder: 0 }],
    } as Provider;
    renderPanel({
      panelProvider: codex,
      credentials: [{ ...unassignedCredential, providerId: 'codex', authTypeId: 'codex:api-key' }],
      onImportCli,
      onStartClaudeCodeLogin: vi.fn(),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Use local CLI login' }));
    expect(onImportCli).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'Sign in with Claude Code' })
    ).not.toBeInTheDocument();
  });
});

/** Whether a button is drawn as the panel's primary action. */
const isPrimary = (button: HTMLElement) => /variantPrimary/.test(button.className);

describe('DetailPanel connect actions', () => {
  it('makes the sign-in the one primary action when a panel also offers Add key', () => {
    renderPanel({ credentials: [], onStartClaudeCodeLogin: vi.fn() });
    expect(isPrimary(screen.getByRole('button', { name: 'Sign in with Claude Code' }))).toBe(true);
    expect(isPrimary(screen.getByRole('button', { name: '+ Add key' }))).toBe(false);
    expect(screen.getByText(/No keys yet/)).toHaveTextContent(
      'No keys yet. Click Sign in with Claude Code or + Add key to connect one.'
    );
  });

  it('makes Use local CLI login primary for Codex, with Add key beside it', () => {
    const codex = {
      ...provider,
      id: 'codex',
      name: 'Codex',
      authTypes: [{ id: 'codex:api-key', name: 'API Key', type: 'api_key', sortOrder: 0 }],
    } as Provider;
    renderPanel({ panelProvider: codex, credentials: [], onImportCli: vi.fn() });
    expect(isPrimary(screen.getByRole('button', { name: 'Use local CLI login' }))).toBe(true);
    expect(isPrimary(screen.getByRole('button', { name: '+ Add key' }))).toBe(false);
  });

  it('offers only the sign-in on a subscription card', () => {
    const onStartClaudeCodeLogin = vi.fn();
    renderPanel({ credentials: [], onStartClaudeCodeLogin, connectVia: 'sign-in' });
    expect(screen.queryByRole('button', { name: '+ Add key' })).not.toBeInTheDocument();
    expect(screen.getByText(/No keys yet/)).toHaveTextContent(
      'No keys yet. Click Sign in with Claude Code to connect one.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude Code' }));
    expect(onStartClaudeCodeLogin).toHaveBeenCalledTimes(1);
  });

  it('offers only key entry on an API-key card, as the primary action', () => {
    renderPanel({ credentials: [], onStartClaudeCodeLogin: vi.fn(), connectVia: 'key' });
    expect(
      screen.queryByRole('button', { name: 'Sign in with Claude Code' })
    ).not.toBeInTheDocument();
    expect(isPrimary(screen.getByRole('button', { name: '+ Add key' }))).toBe(true);
    expect(screen.getByText(/No keys yet/)).toHaveTextContent(
      'No keys yet. Click + Add key to connect one.'
    );
  });

  it('keeps Add key on a sign-in card whose provider has no sign-in to offer', () => {
    renderPanel({ credentials: [], connectVia: 'sign-in' });
    expect(isPrimary(screen.getByRole('button', { name: '+ Add key' }))).toBe(true);
  });
});

describe('DetailPanel keyless providers', () => {
  const apple = {
    ...provider,
    id: 'apple-on-device',
    name: 'Apple On-Device',
    authTypes: [{ id: 'apple-on-device:none', name: 'No Auth', type: 'none', sortOrder: 0 }],
  } as Provider;

  it('shows a status line instead of a Keys section', () => {
    renderPanel({ panelProvider: apple, credentials: [] });
    expect(screen.queryByRole('heading', { name: 'Keys' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add key' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No keys yet/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connection' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Not connected yet. No key is needed: Snaglet connects it by itself when it is available.'
    );
  });

  it('says it is connected once Snaglet has connected it', () => {
    renderPanel({
      panelProvider: apple,
      credentials: [
        {
          ...unassignedCredential,
          providerId: apple.id,
          authTypeId: 'apple-on-device:none',
          authType: 'none',
          hasSecret: false,
        },
      ],
    });
    expect(screen.getByRole('status')).toHaveTextContent('Connected. No key is needed.');
    expect(screen.queryByText(unassignedCredential.label)).not.toBeInTheDocument();
  });
});

describe('DetailPanel local connections', () => {
  it.each(['ollama', 'lm-studio'])('hides keys for %s without hiding model discovery', (id) => {
    renderPanel({ panelProvider: { ...provider, id, name: id }, credentials: [] });
    expect(screen.queryByRole('button', { name: '+ Add key' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Keys' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No keys yet/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Models' })).toBeInTheDocument();
    expect(
      screen.getByText(id === 'ollama' ? 'SNAGLET_OLLAMA_URL' : 'SNAGLET_LM_STUDIO_URL')
    ).toBeInTheDocument();
  });

  it('preserves cloud credentials', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: '+ Add key' })).toBeInTheDocument();
    expect(screen.getByText(unassignedCredential.label)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
  });
});

describe('DetailPanel model errors', () => {
  it('shows a failed model change in the Models section while the key form is closed', () => {
    renderPanel({ error: 'Failed to add model' });
    expect(screen.queryByRole('button', { name: '− Close' })).not.toBeInTheDocument();
    const models = screen.getByRole('heading', { name: 'Models' }).closest('section, div');
    expect(models).not.toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to add model');
  });

  it('shows the error once, in the key form, while that form is open', () => {
    renderPanel({ error: 'Failed to add model' });
    fireEvent.click(screen.getByRole('button', { name: '+ Add key' }));
    expect(screen.getAllByText('Failed to add model')).toHaveLength(1);
  });
});

describe('DetailPanel Sign in with GitHub', () => {
  const copilot = {
    ...provider,
    id: 'copilot',
    name: 'GitHub Copilot',
    authTypes: [
      { id: 'copilot:subscription', name: 'GitHub OAuth', type: 'oauth', sortOrder: 0 },
      {
        id: 'copilot:api-key',
        name: 'API Key',
        type: 'api_key',
        sortOrder: 1,
        tokenPlaceholder: 'ghp_…',
      },
    ] as ProviderAuthType[],
  } as Provider;

  /** Holds per-provider drafts the way useProviders does, so panels see their patches. */
  function KeysHarness({
    panelProvider,
    onPatchDraft,
  }: {
    panelProvider: Provider;
    onPatchDraft?: (patch: Partial<CredentialDraft>) => void;
  }) {
    const [drafts, setDrafts] = useState<Record<string, CredentialDraft>>({});
    const current = drafts[panelProvider.id] ?? {
      ...draft,
      authTypeId: getKeyAuthTypes(panelProvider)[0]?.id ?? '',
    };
    return (
      <DetailPanel
        provider={panelProvider}
        providerCredentials={[]}
        fallbacks={[]}
        models={[]}
        usedModelIds={new Set()}
        draft={current}
        selectedAuthType={
          panelProvider.authTypes.find((a) => a.id === current.authTypeId) ??
          panelProvider.authTypes[0]
        }
        multiField={false}
        verify={{ status: 'idle', message: '' }}
        isTesting={false}
        isSaving={false}
        retestStates={{}}
        onPatchDraft={(patch) => {
          onPatchDraft?.(patch);
          setDrafts((prev) => ({
            ...prev,
            [panelProvider.id]: { ...(prev[panelProvider.id] ?? current), ...patch },
          }));
        }}
        onApplyJsonPaste={vi.fn()}
        onTest={vi.fn()}
        onSave={vi.fn()}
        onRetest={vi.fn()}
        onDelete={vi.fn()}
        onMoveCredential={vi.fn().mockResolvedValue(undefined)}
        onEditCredential={vi.fn()}
        onAddModel={vi.fn()}
        onUpdateModel={vi.fn()}
        onRemoveModel={vi.fn()}
        onDiscoverModels={vi.fn().mockResolvedValue({ providerId: panelProvider.id, models: [] })}
        onImportModels={vi.fn()}
      />
    );
  }

  const deviceFlow = () => screen.queryByTestId('github-device-flow');
  const keyInput = () => screen.queryByPlaceholderText('ghp_…');

  it('puts Sign in with GitHub before + Add key in the Keys header', async () => {
    const user = userEvent.setup();
    render(<KeysHarness panelProvider={copilot} />);

    const signIn = screen.getByRole('button', { name: 'Sign in with GitHub' });
    const addKey = screen.getByRole('button', { name: '+ Add key' });
    expect(addKey.parentElement).toContainElement(signIn);
    expect(signIn).toHaveAttribute('aria-pressed', 'false');
    expect(signIn).toHaveAttribute('title', expect.stringContaining('github.com/login/device'));
    expect(addKey).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(/No keys yet/)).toHaveTextContent(
      'No keys yet. Click Sign in with GitHub or + Add key to connect one.'
    );

    signIn.focus();
    await user.tab();
    expect(addKey).toHaveFocus();
  });

  it('starts the device flow from its own button, without the Add key form', async () => {
    const user = userEvent.setup();
    const onPatchDraft = vi.fn();
    render(<KeysHarness panelProvider={copilot} onPatchDraft={onPatchDraft} />);

    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));

    expect(deviceFlow()).toHaveAttribute('data-auto-start', 'true');
    expect(screen.getByRole('textbox', { name: /Label/ })).toBeInTheDocument();
    expect(keyInput()).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Auth type' })).not.toBeInTheDocument();
    expect(onPatchDraft).toHaveBeenCalledWith(
      expect.objectContaining({ authTypeId: 'copilot:subscription', secret: '' })
    );
    expect(screen.getByRole('button', { name: '− Close' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '+ Add key' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('opens + Add key as an API-key form with no OAuth tab', async () => {
    const user = userEvent.setup();
    render(<KeysHarness panelProvider={copilot} />);

    await user.click(screen.getByRole('button', { name: '+ Add key' }));

    expect(keyInput()).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(deviceFlow()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '− Close' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps one panel open at a time, and Close closes whichever is open', async () => {
    const user = userEvent.setup();
    render(<KeysHarness panelProvider={copilot} />);

    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    await user.click(screen.getByRole('button', { name: '+ Add key' }));
    expect(deviceFlow()).not.toBeInTheDocument();
    expect(keyInput()).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '− Close' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    expect(keyInput()).not.toBeInTheDocument();
    expect(deviceFlow()).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '− Close' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '− Close' }));
    expect(deviceFlow()).not.toBeInTheDocument();
    expect(keyInput()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add key' })).toBeInTheDocument();
  });

  it('drops a device-flow token instead of showing it in the Add key form', async () => {
    const user = userEvent.setup();
    render(<KeysHarness panelProvider={copilot} />);

    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    await user.click(screen.getByRole('button', { name: 'Complete GitHub auth' }));
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: '+ Add key' }));
    expect(keyInput()).toHaveValue('');
  });

  it('closes Sign in with GitHub when the provider changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<KeysHarness panelProvider={copilot} />);

    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    expect(deviceFlow()).toBeInTheDocument();

    rerender(<KeysHarness panelProvider={provider} />);
    expect(deviceFlow()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub' })).not.toBeInTheDocument();

    rerender(<KeysHarness panelProvider={copilot} />);
    expect(deviceFlow()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
  });

  it('moves a Copilot draft left on the OAuth type back to API key under an open Add key form', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<KeysHarness panelProvider={copilot} />);

    // Sign-in leaves Copilot's draft on the OAuth type; the switch closes it.
    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    await user.click(screen.getByRole('button', { name: 'Complete GitHub auth' }));
    rerender(<KeysHarness panelProvider={provider} />);
    await user.click(screen.getByRole('button', { name: '+ Add key' }));

    rerender(<KeysHarness panelProvider={copilot} />);

    expect(keyInput()).toHaveValue('');
    expect(deviceFlow()).not.toBeInTheDocument();
  });
});
