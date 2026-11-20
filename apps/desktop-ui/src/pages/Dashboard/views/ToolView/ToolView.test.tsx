import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { ToolRow } from '@desktop/utils/api';
import { agentsApi, toolsApi } from '@desktop/utils/api';
import { ToolView } from './ToolView';

vi.mock('@desktop/utils/api', () => ({
  toolsApi: { execute: vi.fn(), setEnabled: vi.fn() },
  agentsApi: { list: vi.fn() },
}));

vi.mock('@desktop/utils/workspaceEvents.js', () => ({
  emitLibraryEvent: vi.fn(),
  onLibraryEvent: () => () => {},
}));

vi.mock('@desktop/components', async () => {
  const controls = await vi.importActual<typeof import('@desktop/components/controls')>(
    '@desktop/components/controls'
  );
  const { HelpTooltip } = await vi.importActual<
    typeof import('@desktop/components/Tooltip/HelpTooltip')
  >('@desktop/components/Tooltip/HelpTooltip');
  return {
    Button: controls.Button,
    Select: controls.Select,
    Switch: controls.Switch,
    HelpTooltip,
  };
});

vi.mock('@desktop/features/rich-markdown/editor/index.js', () => ({
  ChipEditableInput: () => <div data-testid="chip-editable-input" />,
}));

const executeMock = vi.mocked(toolsApi.execute);
const setEnabledMock = vi.mocked(toolsApi.setEnabled);
const agentListMock = vi.mocked(agentsApi.list);

const sampleAgents = [
  { id: 'a1', name: 'Alpha' },
  { id: 'a2', name: 'Beta' },
] as unknown as SnagletAgent[];

function makeTool(overrides: Partial<ToolRow> & Pick<ToolRow, 'id' | 'name'>): ToolRow {
  return {
    description: '',
    type: 'builtin',
    parametersSchema: {},
    source: null,
    configJson: {},
    aliases: [],
    enabled: true,
    tier: 'standard',
    categoryPath: 'uncategorized',
    providerId: null,
    availability: 'available',
    keywords: [],
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ToolView Run action', () => {
  beforeEach(() => {
    executeMock.mockReset();
    setEnabledMock.mockReset();
    agentListMock.mockReset();
    agentListMock.mockResolvedValue([]);
  });

  it('shows an honest disabled message — not the raw error — when the execute route is unmounted (404 status)', async () => {
    // This is what a real run against a dev server produces when
    // SNAGLET_ENABLE_UNSAFE_TOOL_EXECUTION isn't set: executionRoutes never gets
    // mounted, so the request 404s before any tool-specific handler runs.
    // Detection keys on `err.status === 404` (set by fetchJson's FetchError
    // from the raw HTTP response code — see utils/api/core.ts), NOT on the
    // error message string: the message varies with the response body shape
    // (a JSON error envelope's `error.message` vs. the generic `HTTP ${status}`
    // fallback when the body isn't JSON — e.g. before the server's `/api`
    // 404-handler mount was fixed from a non-matching Express-5 wildcard,
    // unmatched routes fell through to Express's own HTML "Cannot POST ..."
    // page). Status is the one thing stable across both server eras, so the
    // mock here carries a realistic post-fix JSON-404 message alongside the
    // `.status` that actually drives the check.
    executeMock.mockRejectedValue(
      Object.assign(new Error('Route POST /tools/execute not found'), { status: 404 })
    );
    const tool = makeTool({ id: 'echo', name: 'echo-tool' });
    render(<ToolView tool={tool} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Run' }));

    expect(
      await screen.findByText('Tool execution is disabled in this build.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Route POST /tools/execute not found')).not.toBeInTheDocument();

    // A second click shouldn't be needed to learn this — the button disables
    // itself after the first disabled response instead of inviting a repeat 404.
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });

  it('still shows the raw error for unrelated run failures', async () => {
    executeMock.mockRejectedValue(new Error('Tool not found'));
    const tool = makeTool({ id: 'echo', name: 'echo-tool' });
    render(<ToolView tool={tool} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByText('Tool not found')).toBeInTheDocument();
    expect(screen.queryByText('Tool execution is disabled in this build.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).not.toBeDisabled();
  });

  it('does NOT show the disabled message for a non-404 error that happens to carry a status', async () => {
    // Guard against over-matching: a 500 (or any non-404) must fall through
    // to the generic error path even though it has a `.status` property, same
    // shape as the 404 case — only 404 means "route not mounted".
    executeMock.mockRejectedValue(Object.assign(new Error('Internal error'), { status: 500 }));
    const tool = makeTool({ id: 'echo', name: 'echo-tool' });
    render(<ToolView tool={tool} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByText('Internal error')).toBeInTheDocument();
    expect(screen.queryByText('Tool execution is disabled in this build.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).not.toBeDisabled();
  });

  it('shows the platform limitation and blocks a tool the server marked unsupported', () => {
    const tool = makeTool({
      id: 'ocr_image',
      name: 'Extract Text from Image',
      availability: 'unsupported_platform',
    });
    render(<ToolView tool={tool} />);

    expect(screen.getByText('Available on macOS only.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });

  it('keeps the server platform availability after disabling then re-enabling OCR', async () => {
    const tool = makeTool({
      id: 'ocr_image',
      name: 'Extract Text from Image',
      availability: 'unsupported_platform',
    });
    setEnabledMock
      .mockResolvedValueOnce(makeTool({ ...tool, enabled: false, availability: 'disabled' }))
      .mockResolvedValueOnce(
        makeTool({ ...tool, enabled: true, availability: 'unsupported_platform' })
      );
    render(<ToolView tool={tool} />);

    await userEvent
      .setup()
      .click(screen.getByRole('switch', { name: 'Disable tool for all agents' }));
    await screen.findByRole('switch', { name: 'Enable tool for all agents' });

    await userEvent
      .setup()
      .click(screen.getByRole('switch', { name: 'Enable tool for all agents' }));

    expect(setEnabledMock).toHaveBeenNthCalledWith(1, 'ocr_image', false);
    expect(setEnabledMock).toHaveBeenNthCalledWith(2, 'ocr_image', true);
    expect(screen.getByText('Available on macOS only.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });

  it('shows a distinct "not authorized" message — not the disabled message — on a 403 from panelAuthMiddleware', async () => {
    // panelAuthMiddleware (apps/server/src/middleware/panelAuth.ts) rejects a
    // missing/invalid X-Snaglet-Panel-Token with 403, never 404 — the route IS
    // mounted, this request just wasn't authorized. Must not be confused with
    // the "execution disabled in this build" 404 case: a 403 shouldn't
    // permanently disable the button (a retry after the panel token arrives —
    // e.g. the dev-mode WebSocket push — can succeed).
    executeMock.mockRejectedValue(
      Object.assign(new Error('Unauthorized: missing or invalid panel execution token'), {
        status: 403,
      })
    );
    const tool = makeTool({ id: 'echo', name: 'echo-tool' });
    render(<ToolView tool={tool} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Run' }));

    expect(
      await screen.findByText(/not authorized to run tools from this panel/i)
    ).toBeInTheDocument();
    expect(screen.queryByText('Tool execution is disabled in this build.')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Unauthorized: missing or invalid panel execution token')
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).not.toBeDisabled();
  });
});

describe('ToolView act-as agent picker', () => {
  beforeEach(() => {
    executeMock.mockReset();
    agentListMock.mockReset();
    agentListMock.mockResolvedValue([]);
  });

  it('renders a required picker for agent-required tools and blocks Run until an agent is chosen', async () => {
    agentListMock.mockResolvedValue(sampleAgents);
    executeMock.mockResolvedValue({ success: true, output: 'ok', durationMs: 1 });
    const tool = makeTool({
      id: 'memory_store',
      name: 'Store Memory',
      contextRequirement: 'agent-required',
    });
    render(<ToolView tool={tool} />);

    const picker = await screen.findByRole('combobox', { name: /act as agent/i });
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();

    const user = userEvent.setup();
    await user.selectOptions(picker, 'a1');
    const run = screen.getByRole('button', { name: 'Run' });
    expect(run).not.toBeDisabled();

    await user.click(run);
    expect(executeMock).toHaveBeenCalledWith('memory_store', {}, { actAsAgentId: 'a1' });
  });

  it('shows no picker for tools without a declared context requirement', () => {
    const tool = makeTool({ id: 'echo', name: 'echo-tool' });
    render(<ToolView tool={tool} />);

    expect(screen.queryByRole('combobox', { name: /act as agent/i })).not.toBeInTheDocument();
    expect(agentListMock).not.toHaveBeenCalled();
  });

  it('keeps the picker optional for agent-optional tools — Run works with no agent selected', async () => {
    agentListMock.mockResolvedValue(sampleAgents);
    executeMock.mockResolvedValue({ success: true, output: 'ok', durationMs: 1 });
    const tool = makeTool({
      id: 'my_activity',
      name: 'my-activity',
      contextRequirement: 'agent-optional',
    });
    render(<ToolView tool={tool} />);

    await screen.findByRole('combobox', { name: /act as agent/i });
    const run = screen.getByRole('button', { name: 'Run' });
    expect(run).not.toBeDisabled();

    await userEvent.setup().click(run);
    expect(executeMock).toHaveBeenCalledWith('my_activity', {}, undefined);
  });
});

describe('ToolView destructive confirm gate', () => {
  beforeEach(() => {
    executeMock.mockReset();
    agentListMock.mockReset();
    agentListMock.mockResolvedValue([]);
  });

  it('arms a confirm step on the first Run click — POSTs only after explicit confirmation', async () => {
    executeMock.mockResolvedValue({ success: true, output: 'done', durationMs: 2 });
    const tool = makeTool({ id: 'database_execute', name: 'db-exec', destructive: true });
    render(<ToolView tool={tool} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(executeMock).not.toHaveBeenCalled();
    expect(screen.getByText(/flagged destructive/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /confirm run/i }));
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('cancel disarms the confirm step without executing', async () => {
    const tool = makeTool({ id: 'database_execute', name: 'db-exec', destructive: true });
    render(<ToolView tool={tool} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(executeMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /confirm run/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
  });
});

describe('ToolView per-op destructive gate (destructiveOps)', () => {
  beforeEach(() => {
    executeMock.mockReset();
    agentListMock.mockReset();
    agentListMock.mockResolvedValue([]);
    executeMock.mockResolvedValue({ success: true, output: 'ok', durationMs: 1 });
  });

  const mergedTool = () =>
    makeTool({
      id: 'merged_thread',
      name: 'merged-thread',
      parametersSchema: {
        type: 'object',
        properties: { op: { type: 'string', enum: ['get', 'delete'] } },
      },
      destructiveOps: ['delete'],
    } as Partial<ToolRow> & Pick<ToolRow, 'id' | 'name'>);

  it('runs a non-destructive op without a confirm step', async () => {
    render(<ToolView tool={mergedTool()} />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText(/^op \(/), 'get');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/flagged destructive/i)).not.toBeInTheDocument();
  });

  it('arms the confirm step for the destructive op', async () => {
    render(<ToolView tool={mergedTool()} />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText(/^op \(/), 'delete');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(executeMock).not.toHaveBeenCalled();
    expect(screen.getByText(/flagged destructive/i)).toBeInTheDocument();
  });

  it('asks when no op is chosen yet (safe direction)', async () => {
    render(<ToolView tool={mergedTool()} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(executeMock).not.toHaveBeenCalled();
    expect(screen.getByText(/flagged destructive/i)).toBeInTheDocument();
  });
});

describe('ToolView dispatch-only tools', () => {
  beforeEach(() => {
    executeMock.mockReset();
    agentListMock.mockReset();
    agentListMock.mockResolvedValue([]);
  });

  it('hides Run and explains why for dispatchOnly tools', () => {
    const tool = makeTool({ id: 'action', name: 'action', dispatchOnly: true });
    render(<ToolView tool={tool} />);

    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    expect(screen.getByText(/only runs inside a live agent/i)).toBeInTheDocument();
  });
});

describe('ToolView catalog exposure and capability operations', () => {
  beforeEach(() => {
    executeMock.mockReset();
    agentListMock.mockReset();
    agentListMock.mockResolvedValue([]);
  });

  it('labels catalog exposure from CORE_TOOL_IDS instead of the mutable definition tier', () => {
    const { rerender } = render(
      <ToolView tool={makeTool({ id: 'doc', name: 'Get Doc', tier: 'standard' })} />
    );

    expect(screen.getByText('core')).toHaveAttribute('title', 'Advertised to agents on every turn');

    rerender(<ToolView tool={makeTool({ id: 'google_gmail', name: 'Gmail', tier: 'core' })} />);
    expect(screen.getByText('on demand')).toHaveAttribute(
      'title',
      'Discovered by agents when needed'
    );
  });

  it('renders a capability operation enum as a select and executes the selected operation', async () => {
    executeMock.mockResolvedValue({ success: true, output: 'sent', durationMs: 1 });
    const tool = makeTool({
      id: 'google_gmail',
      name: 'Gmail',
      parametersSchema: {
        type: 'object',
        required: ['operation'],
        properties: {
          operation: {
            type: 'string',
            enum: ['send', 'search', 'get_thread'],
            description: 'Gmail operation to run.',
          },
        },
      },
    });
    render(<ToolView tool={tool} />);

    const operation = screen.getByRole('combobox', { name: 'operation (string)' });
    // The description is in the field's help tooltip, not repeated as text.
    expect(screen.getByRole('button', { name: 'About operation' })).toBeInTheDocument();
    expect(screen.queryByText('Gmail operation to run.', { selector: 'span' })).toBeNull();
    expect(
      Array.from((operation as HTMLSelectElement).options).map((option) => option.value)
    ).toEqual(['', 'send', 'search', 'get_thread']);

    const user = userEvent.setup();
    await user.selectOptions(operation, 'send');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(executeMock).toHaveBeenCalledWith('google_gmail', { operation: 'send' }, undefined);
  });

  it('keeps a parameter hint from taking clicks meant for its input', async () => {
    const tool = makeTool({
      id: 'search',
      name: 'Search',
      parametersSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for.' },
          limit: { type: 'integer', description: 'How many results.' },
        },
      },
    });
    render(<ToolView tool={tool} />);

    const queryHint = screen.getByRole('button', { name: 'About query' });
    const limitHint = screen.getByRole('button', { name: 'About limit' });
    // A field label forwards clicks and focus to its control: never the hint.
    expect(queryHint.closest('label')?.control).toBeNull();
    expect(limitHint.closest('label')?.control).toBe(screen.getByRole('spinbutton'));

    const user = userEvent.setup();
    await user.click(screen.getByTestId('chip-editable-input'));
    expect(document.activeElement).not.toBe(queryHint);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('ToolView edit affordance', () => {
  // Whether an Edit button shows at all is entirely driven by whether the
  // caller passes `onEdit` — ToolPane is the one that decides that (gated by
  // `toolIdFromSource`, i.e. workspace-sourced vs. builtin/mcp), not ToolView
  // itself. So this suite only pins ToolView's own contract: render the
  // button when `onEdit` is given, wire clicks straight to it, and render
  // nothing extra when it's omitted.
  beforeEach(() => {
    executeMock.mockReset();
    agentListMock.mockReset();
    agentListMock.mockResolvedValue([]);
  });

  it('renders an Edit button that calls onEdit when the caller provides one', async () => {
    const onEdit = vi.fn();
    const tool = makeTool({ id: 'echo', name: 'echo-tool', source: 'workspace:echo-tool' });
    render(<ToolView tool={tool} onEdit={onEdit} />);

    const editButton = screen.getByRole('button', { name: 'Edit tool' });
    await userEvent.setup().click(editButton);

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('renders no Edit button when the caller omits onEdit (e.g. a builtin/mcp tool via ToolPane)', () => {
    const tool = makeTool({ id: 'echo', name: 'echo-tool' });
    render(<ToolView tool={tool} />);

    expect(screen.queryByRole('button', { name: 'Edit tool' })).not.toBeInTheDocument();
  });
});
