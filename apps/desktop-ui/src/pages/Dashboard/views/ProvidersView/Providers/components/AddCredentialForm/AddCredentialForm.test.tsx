import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MetadataField, Provider, ProviderAuthType } from '@desktop/utils/api';
import type { CredentialDraft, VerifyState } from '../../types';
import { parseJsonPaste, resolveMetadata, validateCredentialFormat } from '../../utils';
import { AddCredentialForm } from './AddCredentialForm';

vi.mock('../CopilotDeviceFlow/CopilotDeviceFlow.js', () => ({
  CopilotDeviceFlow: ({
    onToken,
    completionMode,
    autoStart,
  }: {
    onToken: (token: string) => void;
    completionMode?: 'explicit-save' | 'auto-save';
    autoStart?: boolean;
  }) => (
    <div>
      <span data-testid="completion-mode">{completionMode}</span>
      <span data-testid="auto-start">{String(Boolean(autoStart))}</span>
      <button type="button" onClick={() => onToken('gho_super_secret_token')}>
        Complete GitHub auth
      </button>
    </div>
  ),
}));

const apiKeyProvider = {
  id: 'openai',
  name: 'OpenAI',
  type: 'llm',
  website: null,
  baseUrl: null,
  primaryCredentialId: null,
  authTypes: [{ id: 'openai:api-key', name: 'API Key', type: 'api_key', sortOrder: 0 }],
} as Provider;

const copilotOAuth = {
  id: 'copilot:subscription',
  name: 'GitHub OAuth',
  type: 'oauth',
  sortOrder: 0,
} as ProviderAuthType;
const copilotApiKey = {
  id: 'copilot:api-key',
  name: 'API Key',
  type: 'api_key',
  sortOrder: 1,
  tokenPlaceholder: 'ghp_…',
  tokenHelp: 'Get your token at github.com/settings/tokens with the Copilot scope.',
} as ProviderAuthType;

const copilotProvider = {
  id: 'copilot',
  name: 'GitHub Copilot',
  type: 'llm',
  website: null,
  baseUrl: null,
  primaryCredentialId: null,
  authTypes: [copilotOAuth, copilotApiKey],
} as Provider;

const baseDraft: CredentialDraft = {
  authTypeId: 'copilot:subscription',
  label: '',
  secret: '',
  metadata: {},
  pasteMode: false,
  jsonPaste: '',
  jsonError: null,
};

function renderForm({
  provider = copilotProvider,
  draft = baseDraft,
  githubSignIn = false,
  authTypes,
  selectedAuthType,
  isSaving = false,
  error = null,
  verify = { status: 'idle', message: '' },
  onSave = vi.fn(),
}: {
  provider?: Provider;
  draft?: CredentialDraft;
  githubSignIn?: boolean;
  authTypes?: ProviderAuthType[];
  /** Fixed auth type, as the sign-in panel passes; otherwise derived from the draft. */
  selectedAuthType?: ProviderAuthType;
  isSaving?: boolean;
  error?: string | null;
  verify?: VerifyState;
  onSave?: ReturnType<typeof vi.fn>;
} = {}) {
  let currentDraft = draft;
  const onPatchDraft = vi.fn((patch: Partial<CredentialDraft>) => {
    currentDraft = { ...currentDraft, ...patch };
    rerenderWith(currentDraft);
  });

  const renderProps = (nextDraft: CredentialDraft) => ({
    provider,
    draft: nextDraft,
    githubSignIn,
    authTypes,
    selectedAuthType:
      selectedAuthType ??
      provider.authTypes.find((authType) => authType.id === nextDraft.authTypeId) ??
      provider.authTypes[0],
    multiField: false,
    verify,
    isTesting: verify.status === 'testing',
    isSaving,
    error,
    onPatchDraft,
    onApplyJsonPaste: vi.fn(),
    onTest: vi.fn(),
    onSave,
  });

  const utils = render(<AddCredentialForm {...renderProps(currentDraft)} />);
  const rerenderWith = (nextDraft: CredentialDraft) => {
    utils.rerender(<AddCredentialForm {...renderProps(nextDraft)} />);
  };

  return { ...utils, onPatchDraft, onSave };
}

describe('AddCredentialForm Sign in with GitHub', () => {
  const signIn = { githubSignIn: true, selectedAuthType: copilotOAuth };

  it('starts the device flow at once and renders an explicit Connect action', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderForm({ ...signIn, onSave });

    expect(screen.getByTestId('auto-start')).toHaveTextContent('true');
    expect(screen.getByTestId('completion-mode')).toHaveTextContent('explicit-save');
    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Complete GitHub auth' }));

    expect(screen.queryByText('gho_super_secret_token')).not.toBeInTheDocument();
    expect(connect).toBeEnabled();

    await user.click(connect);

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('offers the optional label and no auth-type switcher', () => {
    renderForm(signIn);

    expect(screen.getByRole('textbox', { name: /Label/ })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Auth type' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
  });

  it('saves the token under the OAuth auth type even after a reset to the key default', async () => {
    const user = userEvent.setup();
    const { onPatchDraft } = renderForm({
      ...signIn,
      draft: { ...baseDraft, authTypeId: copilotApiKey.id },
    });

    await user.click(screen.getByRole('button', { name: 'Complete GitHub auth' }));

    expect(onPatchDraft).toHaveBeenCalledWith({
      authTypeId: copilotOAuth.id,
      secret: 'gho_super_secret_token',
    });
  });

  it('keeps the acquired-token state visible and retryable when save fails', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderForm({ ...signIn, onSave, error: 'Failed to connect credential' });

    await user.click(screen.getByRole('button', { name: 'Complete GitHub auth' }));

    expect(screen.getByText('Failed to connect credential')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Complete GitHub auth' })).toBeInTheDocument();
  });

  it('shows loading and prevents duplicate submission while saving', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderForm({
      ...signIn,
      draft: { ...baseDraft, secret: 'gho_saved_in_draft' },
      isSaving: true,
      onSave,
    });

    const connect = screen.getByRole('button', { name: 'Connecting…' });
    expect(connect).toBeDisabled();

    await user.dblClick(connect);

    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('AddCredentialForm Add key auth types', () => {
  it('keeps the standard API-key action row unchanged', () => {
    renderForm({
      provider: apiKeyProvider,
      draft: { ...baseDraft, authTypeId: 'openai:api-key' },
    });

    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Complete GitHub auth' })).not.toBeInTheDocument();
  });

  it('shows only the API-key form for GitHub Copilot, with no OAuth tab', () => {
    renderForm({
      draft: { ...baseDraft, authTypeId: copilotApiKey.id },
      authTypes: [copilotApiKey],
    });

    expect(screen.queryByRole('group', { name: 'Auth type' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'GitHub OAuth' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Complete GitHub auth' })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('ghp_…')).toHaveAttribute('type', 'password');
    expect(screen.getByText(copilotApiKey.tokenHelp!)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('keeps the auth-type switcher for other providers with several auth types', async () => {
    const user = userEvent.setup();
    const anthropic = {
      ...apiKeyProvider,
      id: 'anthropic',
      name: 'Anthropic',
      authTypes: [
        { id: 'anthropic:api-key', name: 'API Key', type: 'api_key', sortOrder: 0 },
        { id: 'anthropic:claude-code-pro', name: 'Claude Code Pro', type: 'oauth', sortOrder: 1 },
      ],
    } as Provider;
    const { onPatchDraft } = renderForm({
      provider: anthropic,
      draft: { ...baseDraft, authTypeId: 'anthropic:api-key' },
    });

    expect(screen.getByRole('radio', { name: 'API Key' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Claude Code Pro' }));

    expect(onPatchDraft).toHaveBeenCalledWith(
      expect.objectContaining({ authTypeId: 'anthropic:claude-code-pro' })
    );
  });
});

describe('AddCredentialForm Connect is independent of Test', () => {
  const apiKeyDraft = { ...baseDraft, authTypeId: 'openai:api-key', secret: 'sk-live-123' };

  it('keeps Connect enabled and saves after a failed Test', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderForm({
      provider: apiKeyProvider,
      draft: apiKeyDraft,
      verify: { status: 'fail', message: 'Unauthorized' },
      onSave,
    });

    expect(screen.getByRole('status')).toHaveTextContent('✗ Unauthorized');
    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect).toBeEnabled();
    await user.click(connect);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('tells the user Test is optional and shows the untested notice after saving', () => {
    renderForm({
      provider: apiKeyProvider,
      draft: { ...baseDraft, authTypeId: 'openai:api-key' },
      verify: { status: 'untested', message: 'Saved — not tested. Use Retest to verify.' },
    });

    expect(screen.getByText(/Test is optional/)).toBeInTheDocument();
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Saved — not tested. Use Retest to verify.');
    expect(notice).not.toHaveTextContent('✓');
  });

  it('only disables Connect while a Test is actually running', () => {
    renderForm({
      provider: apiKeyProvider,
      draft: apiKeyDraft,
      verify: { status: 'testing', message: '' },
    });

    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Testing…' })).toBeDisabled();
  });
});

describe('AddCredentialForm Paste JSON', () => {
  const b64url = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const accessToken = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: 'test-user' })}.sig`;

  const subscriptionAuth: ProviderAuthType = {
    id: 'codex:codex-subscription',
    name: 'Codex Subscription',
    type: 'oauth',
    description: '',
    sortOrder: 0,
    metadataFields: [
      { key: 'access_token', label: 'Access Token', inputType: 'password' },
      { key: 'refresh_token', label: 'Refresh Token', inputType: 'password' },
      { key: 'account_id', label: 'Account ID', inputType: 'text' },
    ],
  };
  const codexProvider = {
    id: 'codex',
    name: 'Codex',
    type: 'llm',
    website: null,
    baseUrl: null,
    primaryCredentialId: null,
    authTypes: [subscriptionAuth],
  } as Provider;

  /**
   * Holds the draft the way the providers hook does: `onApplyJsonPaste` runs
   * the real parser, and Connect reports what the real save path would check
   * and send.
   */
  function PasteHarness({
    onSave,
  }: {
    onSave: (result: {
      formatError: string | null;
      metadata: Record<string, unknown> | undefined;
    }) => void;
  }) {
    const [draft, setDraft] = useState<CredentialDraft>({
      ...baseDraft,
      authTypeId: subscriptionAuth.id,
    });
    const patch = (next: Partial<CredentialDraft>) => setDraft((prev) => ({ ...prev, ...next }));
    return (
      <AddCredentialForm
        provider={codexProvider}
        draft={draft}
        selectedAuthType={subscriptionAuth}
        multiField
        verify={{ status: 'idle', message: '' }}
        isTesting={false}
        isSaving={false}
        onPatchDraft={patch}
        onApplyJsonPaste={(fields: MetadataField[], json: string) => {
          const { metadata, error } = parseJsonPaste(json, fields);
          patch({ metadata, jsonError: error, jsonPaste: json });
        }}
        onTest={vi.fn()}
        onSave={() =>
          onSave({
            formatError: validateCredentialFormat(codexProvider, subscriptionAuth, draft),
            metadata: resolveMetadata(draft, subscriptionAuth),
          })
        }
      />
    );
  }

  async function pasteJson(json: string) {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '{ } Paste JSON' }));
    await user.click(screen.getByRole('textbox', { name: 'Credential JSON' }));
    await user.paste(json);
    return user;
  }

  it('parses pasted JSON into the fields Connect saves', async () => {
    const onSave = vi.fn();
    render(<PasteHarness onSave={onSave} />);

    const user = await pasteJson(
      JSON.stringify({
        access_token: accessToken,
        refresh_token: 'refresh-token-value',
        account_id: 'account-1111',
      })
    );

    expect(screen.getByText('✓ Parsed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(onSave).toHaveBeenCalledWith({
      formatError: null,
      metadata: {
        access_token: accessToken,
        refresh_token: 'refresh-token-value',
        account_id: 'account-1111',
      },
    });
  });

  it('shows an inline error for invalid JSON and never reports it as parsed', async () => {
    const onSave = vi.fn();
    render(<PasteHarness onSave={onSave} />);

    const user = await pasteJson('{"access_token": ');

    expect(screen.getByText('Invalid JSON')).toBeInTheDocument();
    expect(screen.queryByText('✓ Parsed')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ formatError: expect.stringMatching(/^Missing required fields/) })
    );
  });

  it('names the keys a pasted object is missing', async () => {
    render(<PasteHarness onSave={vi.fn()} />);

    await pasteJson(JSON.stringify({ access_token: accessToken }));

    expect(screen.getByText('Missing keys: refresh_token, account_id')).toBeInTheDocument();
  });
});
