/**
 * ToolBuilderPanel, the create/edit form for workspace tools. Pins:
 *   - create calls `toolWorkspacesApi.save(toolId, files)` then `deploy`.
 *   - a deploy failure shows its real error and does not call
 *     onSaved/onClose, so the user can fix and retry.
 *   - name validation blocks submit before any API call.
 *   - edit mode saves via `updateFiles`; tool.ts is included only when the
 *     Code tab was edited, and a code save is followed by `deploy`.
 *
 * HandlerEditor is mocked as a `<textarea>`: these tests cover what gets
 * saved and when, not CodeMirror (HandlerEditor.test.tsx mounts the real one).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolRow } from '@desktop/utils/api';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  save: vi.fn(),
  deploy: vi.fn(),
  get: vi.fn(),
  updateFiles: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    toolWorkspacesApi: api,
  };
});

vi.mock('../HandlerEditor/HandlerEditor.js', () => ({
  HandlerEditor: ({
    value,
    onChange,
    readOnly,
    enableNodeMentions,
    enableDropInsert,
    fillHeight,
    'aria-label': ariaLabel,
  }: {
    value: string;
    onChange: (next: string) => void;
    readOnly?: boolean;
    enableNodeMentions?: boolean;
    enableDropInsert?: boolean;
    fillHeight?: boolean;
    'aria-label'?: string;
  }) => (
    <textarea
      aria-label={ariaLabel ?? 'tool.ts handler code'}
      data-node-mentions={String(Boolean(enableNodeMentions))}
      data-drop-insert={String(Boolean(enableDropInsert))}
      data-fill-height={String(Boolean(fillHeight))}
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import { ToolBuilderPanel } from './ToolBuilderPanel';
// FetchError is the real class (the module mock spreads importOriginal), so
// `instanceof FetchError` inside the component matches these test instances.
import { FetchError } from '@desktop/utils/api';
import { scaffoldToolTs } from './scaffold';

/** Switch to the Code tab and return its (mocked) textarea. */
async function openCodeTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /code/i }));
  return screen.findByLabelText(/tool\.ts handler code/i);
}

function makeTool(overrides: Partial<ToolRow> & Pick<ToolRow, 'id' | 'name'>): ToolRow {
  return {
    description: '',
    type: 'external',
    parametersSchema: {},
    source: null,
    configJson: {},
    aliases: [],
    enabled: true,
    tier: 'standard',
    categoryPath: 'custom',
    providerId: null,
    availability: 'available',
    keywords: [],
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ToolBuilderPanel — create mode', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
  });

  it('validates the name and never calls the API on an invalid name', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<ToolBuilderPanel mode="create" onClose={vi.fn()} onSaved={onSaved} />);

    await user.type(screen.getByLabelText(/^name$/i), 'not a valid name!');
    await user.click(screen.getByRole('button', { name: /create tool/i }));

    expect(screen.getByText(/letters, numbers/i)).toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('calls save(toolId, files) then deploy(toolId) with a working scaffold, then reports success', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    api.save.mockResolvedValue({
      workspace: { toolId: 'weather-lookup' },
      tool: makeTool({ id: 'weather_lookup', name: 'weather-lookup', enabled: false }),
    });
    const deployedTool = makeTool({ id: 'weather_lookup', name: 'weather-lookup', enabled: true });
    api.deploy.mockResolvedValue({
      success: true,
      tool: deployedTool,
      install: { success: true, output: '', durationMs: 1 },
      build: { success: true, output: '', durationMs: 2 },
    });

    render(<ToolBuilderPanel mode="create" onClose={onClose} onSaved={onSaved} />);

    await user.type(screen.getByLabelText(/^name$/i), 'weather-lookup');
    await user.type(screen.getByLabelText(/description/i), 'Looks up the weather');
    await user.click(screen.getByRole('button', { name: /create tool/i }));

    await waitFor(() => expect(api.deploy).toHaveBeenCalled());

    expect(api.save).toHaveBeenCalledWith(
      'weather-lookup',
      expect.objectContaining({
        'tool.ts': scaffoldToolTs('weather-lookup'),
      })
    );
    const [, files] = api.save.mock.calls[0] as [string, Record<string, string>];
    const definition = JSON.parse(files['definition.json']);
    expect(definition).toEqual({
      name: 'weather-lookup',
      description: 'Looks up the weather',
      categoryPath: 'custom',
      providerId: null,
      tier: 'standard',
      parametersSchema: { type: 'object', properties: {} },
      keywords: [],
    });
    expect(files['TOOL.md']).toContain('weather-lookup');

    expect(api.deploy).toHaveBeenCalledWith('weather-lookup');
    expect(onSaved).toHaveBeenCalledWith(deployedTool);
    expect(onClose).toHaveBeenCalled();
  });

  it('includes an added parameter row in the deployed definition.json', async () => {
    const user = userEvent.setup();
    api.save.mockResolvedValue({ workspace: {}, tool: makeTool({ id: 'x', name: 'x' }) });
    api.deploy.mockResolvedValue({
      success: true,
      tool: makeTool({ id: 'x', name: 'x', enabled: true }),
      install: { success: true, output: '', durationMs: 1 },
      build: { success: true, output: '', durationMs: 1 },
    });

    render(<ToolBuilderPanel mode="create" onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.type(screen.getByLabelText(/^name$/i), 'my-tool');
    await user.click(screen.getByRole('button', { name: /add parameter/i }));
    await user.type(screen.getByLabelText(/parameter name/i), 'query');
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: /create tool/i }));

    await waitFor(() => expect(api.save).toHaveBeenCalled());
    const [, files] = api.save.mock.calls[0] as [string, Record<string, string>];
    const definition = JSON.parse(files['definition.json']);
    expect(definition.parametersSchema).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
  });

  it('surfaces the real build error from deploy() and does not call onSaved/onClose', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    api.save.mockResolvedValue({
      workspace: {},
      tool: makeTool({ id: 'x', name: 'x', enabled: false }),
    });
    api.deploy.mockResolvedValue({
      success: false,
      step: 'build',
      output: 'esbuild output',
      error: 'tool.ts:3:1 Unexpected token',
      durationMs: 42,
    });

    render(<ToolBuilderPanel mode="create" onClose={onClose} onSaved={onSaved} />);

    await user.type(screen.getByLabelText(/^name$/i), 'my-tool');
    await user.click(screen.getByRole('button', { name: /create tool/i }));

    expect(await screen.findByText(/tool\.ts:3:1 unexpected token/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces the real pnpm output on an install failure, not just the one-line summary', async () => {
    // ToolWorkspaceService.install() always sets `error` to the generic
    // "pnpm install exited with code 1" and puts the actual pnpm failure text
    // in `output`; an `error || output` string would swallow `output` entirely
    // since `error` is never empty on a real failure. Both must reach the user.
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    api.save.mockResolvedValue({
      workspace: {},
      tool: makeTool({ id: 'x', name: 'x', enabled: false }),
    });
    api.deploy.mockResolvedValue({
      success: false,
      step: 'install',
      output: 'ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/left-pad-9000 - Not Found - 404',
      error: 'pnpm install exited with code 1',
      durationMs: 900,
    });

    render(<ToolBuilderPanel mode="create" onClose={onClose} onSaved={onSaved} />);

    await user.type(screen.getByLabelText(/^name$/i), 'my-tool');
    await user.click(screen.getByRole('button', { name: /create tool/i }));

    expect(await screen.findByText(/pnpm install exited with code 1/i)).toBeInTheDocument();
    expect(screen.getByText(/err_pnpm_fetch_404/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces a thrown error from save() (e.g. a transport failure) without calling deploy', async () => {
    const user = userEvent.setup();
    api.save.mockRejectedValue(new Error('Network unreachable'));

    render(<ToolBuilderPanel mode="create" onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.type(screen.getByLabelText(/^name$/i), 'my-tool');
    await user.click(screen.getByRole('button', { name: /create tool/i }));

    expect(await screen.findByText(/network unreachable/i)).toBeInTheDocument();
    expect(api.deploy).not.toHaveBeenCalled();
  });
});

describe('ToolBuilderPanel — edit mode', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    // Edit mode always fetches tool.ts alongside the definition. These tests
    // are about the metadata form, so a benign default keeps them focused on
    // what they pin; Code-tab specifics live in the "Code tab" describe below.
    api.readFile.mockResolvedValue('export default async function handler() {}\n');
  });

  const existing = makeTool({
    id: 'weather_lookup',
    name: 'weather-lookup',
    source: 'workspace:weather-lookup',
    description: 'Old description',
    tier: 'core',
    categoryPath: 'custom',
    keywords: ['weather'],
  });

  it('loads the existing definition via toolWorkspacesApi.get and round-trips it into the form', async () => {
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: ['definition.json', 'tool.ts', 'TOOL.md'],
      hasNodeModules: true,
      hasBuild: true,
      definition: {
        name: 'weather-lookup',
        description: 'Old description',
        categoryPath: 'custom',
        providerId: null,
        tier: 'core',
        parametersSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
        keywords: ['weather'],
      },
    });

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(api.get).toHaveBeenCalledWith('weather-lookup');
    expect(await screen.findByDisplayValue('weather-lookup')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Old description')).toBeInTheDocument();
    expect(screen.getByDisplayValue('city')).toBeInTheDocument();
  });

  it('the name field is disabled in edit mode (renaming would orphan the workspace folder)', async () => {
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: [],
      hasNodeModules: false,
      hasBuild: false,
      definition: { name: 'weather-lookup', tier: 'core', keywords: [] },
    });

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByLabelText(/^name$/i)).toBeDisabled();
  });

  it('saving calls updateFiles(toolId, {definition.json}) only — never save/deploy — and reports success', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: [],
      hasNodeModules: true,
      hasBuild: true,
      definition: {
        name: 'weather-lookup',
        description: 'Old description',
        categoryPath: 'custom',
        providerId: null,
        tier: 'core',
        parametersSchema: {},
        keywords: ['weather'],
      },
    });
    const updatedTool = makeTool({
      id: 'weather_lookup',
      name: 'weather-lookup',
      description: 'New description',
    });
    api.updateFiles.mockResolvedValue({ workspace: {}, tool: updatedTool });

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={onClose} onSaved={onSaved} />);

    const descriptionInput = await screen.findByDisplayValue('Old description');
    await user.clear(descriptionInput);
    await user.type(descriptionInput, 'New description');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(api.updateFiles).toHaveBeenCalled());
    const [calledId, files] = api.updateFiles.mock.calls[0] as [string, Record<string, string>];
    expect(calledId).toBe('weather-lookup');
    expect(Object.keys(files)).toEqual(['definition.json']);
    expect(JSON.parse(files['definition.json']).description).toBe('New description');

    expect(api.save).not.toHaveBeenCalled();
    expect(api.deploy).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(updatedTool);
    expect(onClose).toHaveBeenCalled();
  });

  it('surfaces a load error from toolWorkspacesApi.get without crashing', async () => {
    api.get.mockRejectedValue(new Error('Workspace not found'));

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByText(/workspace not found/i)).toBeInTheDocument();
  });

  it('degrades gracefully for a hand-authored schema the row editor cannot represent', async () => {
    const user = userEvent.setup();
    const unrepresentableSchema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    };
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: [],
      hasNodeModules: true,
      hasBuild: true,
      definition: {
        name: 'weather-lookup',
        description: 'Old description',
        categoryPath: 'custom',
        providerId: null,
        tier: 'core',
        parametersSchema: unrepresentableSchema,
        keywords: [],
      },
    });
    api.updateFiles.mockResolvedValue({
      workspace: {},
      tool: makeTool({ id: 'weather_lookup', name: 'weather-lookup' }),
    });

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={vi.fn()} onSaved={vi.fn()} />);

    // Shows the raw schema read-only instead of the row editor — no "Add
    // parameter" button (that's the row editor's own affordance).
    await screen.findByDisplayValue('Old description');
    expect(screen.queryByRole('button', { name: /add parameter/i })).not.toBeInTheDocument();
    expect(screen.getByText(/tags/)).toBeInTheDocument();

    // Editing only description and saving must carry the original schema
    // through unchanged — nothing here can destroy what it can't display.
    const descriptionInput = screen.getByDisplayValue('Old description');
    await user.clear(descriptionInput);
    await user.type(descriptionInput, 'New description');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(api.updateFiles).toHaveBeenCalled());
    const [, files] = api.updateFiles.mock.calls[0] as [string, Record<string, string>];
    const saved = JSON.parse(files['definition.json']);
    expect(saved.description).toBe('New description');
    expect(saved.parametersSchema).toEqual(unrepresentableSchema);
  });
});

describe('ToolBuilderPanel — Code tab', () => {
  const existing = makeTool({
    id: 'weather_lookup',
    name: 'weather-lookup',
    source: 'workspace:weather-lookup',
    description: 'Old description',
    tier: 'core',
    categoryPath: 'custom',
    keywords: ['weather'],
  });

  const existingDefinition = {
    name: 'weather-lookup',
    description: 'Old description',
    categoryPath: 'custom',
    providerId: null,
    tier: 'core',
    parametersSchema: {},
    keywords: ['weather'],
  };

  const ORIGINAL_TOOL_TS =
    "import snaglet from '@snaglet/sdk';\n\nexport default async function handler(input) {\n  return input;\n}\n";

  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the existing tool.ts content into the editor via readFile(toolId, 'tool.ts')", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: ['definition.json', 'tool.ts', 'TOOL.md'],
      hasNodeModules: true,
      hasBuild: true,
      definition: existingDefinition,
    });
    api.readFile.mockResolvedValue(ORIGINAL_TOOL_TS);

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByDisplayValue('Old description');

    const editor = await openCodeTab(user);
    expect(api.readFile).toHaveBeenCalledWith('weather-lookup', 'tool.ts');
    expect(editor).toHaveValue(ORIGINAL_TOOL_TS);
    expect(editor).toHaveAttribute('data-node-mentions', 'true');
    expect(editor).toHaveAttribute('data-drop-insert', 'true');
    expect(editor).toHaveAttribute('data-fill-height', 'true');
  });

  it('edit → save calls updateFiles with the edited content then deploy(toolId), in order', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: [],
      hasNodeModules: true,
      hasBuild: true,
      definition: existingDefinition,
    });
    api.readFile.mockResolvedValue(ORIGINAL_TOOL_TS);
    api.updateFiles.mockResolvedValue({
      workspace: {},
      tool: makeTool({ id: 'weather_lookup', name: 'weather-lookup' }),
    });
    const deployedTool = makeTool({ id: 'weather_lookup', name: 'weather-lookup', enabled: true });
    api.deploy.mockResolvedValue({
      success: true,
      tool: deployedTool,
      install: { success: true, output: '', durationMs: 1 },
      build: { success: true, output: '', durationMs: 2 },
    });

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={onClose} onSaved={onSaved} />);
    await screen.findByDisplayValue('Old description');

    const editor = await openCodeTab(user);
    const editedCode = ORIGINAL_TOOL_TS.replace('return input;', 'return { ok: true };');
    // fireEvent.change (not user.type) — the replacement text contains `{`/`}`,
    // which user.type's keyboard DSL parses as special-key syntax rather than
    // literal characters. This mocked textarea doesn't need realistic
    // per-keystroke simulation anyway (HandlerEditor.test.tsx covers that
    // against the real CodeMirror editor).
    fireEvent.change(editor, { target: { value: editedCode } });

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(api.deploy).toHaveBeenCalled());
    expect(api.updateFiles).toHaveBeenCalledWith(
      'weather-lookup',
      expect.objectContaining({ 'tool.ts': editedCode })
    );
    expect(api.deploy).toHaveBeenCalledWith('weather-lookup');

    // updateFiles must land before deploy — writing the file has to precede
    // the rebuild that reads it.
    const updateFilesOrder = api.updateFiles.mock.invocationCallOrder[0];
    const deployOrder = api.deploy.mock.invocationCallOrder[0];
    expect(updateFilesOrder).toBeLessThan(deployOrder);

    expect(onSaved).toHaveBeenCalledWith(deployedTool);
    expect(onClose).toHaveBeenCalled();
  });

  it('fails closed when tool.ts cannot be re-read before an edited save', async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: [],
      hasNodeModules: true,
      hasBuild: true,
      definition: existingDefinition,
    });
    api.readFile.mockResolvedValueOnce(ORIGINAL_TOOL_TS).mockRejectedValue(new Error('offline'));

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByDisplayValue('Old description');
    const editor = await openCodeTab(user);
    fireEvent.change(editor, { target: { value: `${ORIGINAL_TOOL_TS}\n// mine` } });

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(
      await screen.findByText(/could not re-read tool\.ts before saving/i)
    ).toBeInTheDocument();
    expect(api.updateFiles).not.toHaveBeenCalled();
    expect(api.deploy).not.toHaveBeenCalled();
    expect(editor).toHaveValue(`${ORIGINAL_TOOL_TS}\n// mine`);
  });

  it('surfaces a build error from deploy() after an edited save, and does not call onSaved/onClose', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: [],
      hasNodeModules: true,
      hasBuild: true,
      definition: existingDefinition,
    });
    api.readFile.mockResolvedValue(ORIGINAL_TOOL_TS);
    api.updateFiles.mockResolvedValue({
      workspace: {},
      tool: makeTool({ id: 'weather_lookup', name: 'weather-lookup' }),
    });
    api.deploy.mockResolvedValue({
      success: false,
      step: 'build',
      output: 'esbuild output',
      error: 'tool.ts:3:1 Unexpected token',
      durationMs: 42,
    });

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={onClose} onSaved={onSaved} />);
    await screen.findByDisplayValue('Old description');

    const editor = await openCodeTab(user);
    await user.type(editor, '\n// oops');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/tool\.ts:3:1 unexpected token/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a dirty indicator only after the code is edited, and asks for confirmation on cancel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: [],
      hasNodeModules: true,
      hasBuild: true,
      definition: existingDefinition,
    });
    api.readFile.mockResolvedValue(ORIGINAL_TOOL_TS);

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={onClose} onSaved={vi.fn()} />);
    await screen.findByDisplayValue('Old description');

    const editor = await openCodeTab(user);
    // Untouched: no "Unsaved" label, and cancel closes with no prompt.
    expect(screen.queryByText(/unsaved/i)).not.toBeInTheDocument();

    await user.type(editor, '\n// a tweak');
    expect(await screen.findByText(/unsaved/i)).toBeInTheDocument();

    // The discard prompt is the in-app ConfirmModal — window.confirm is
    // suppressed by the Tauri webview, so it must never be involved.
    const nativeConfirm = vi.spyOn(window, 'confirm');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    let dialog = screen.getByRole('dialog', { name: 'Discard unsaved code changes?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    dialog = screen.getByRole('dialog', { name: 'Discard unsaved code changes?' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('does not prompt on cancel when only metadata (not code) was edited', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: [],
      hasNodeModules: true,
      hasBuild: true,
      definition: existingDefinition,
    });
    api.readFile.mockResolvedValue(ORIGINAL_TOOL_TS);

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={onClose} onSaved={vi.fn()} />);
    const descriptionInput = await screen.findByDisplayValue('Old description');
    await user.type(descriptionInput, ' plus more');

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalled();
  });

  it('new-tool flow seeds the Code tab with the working scaffold for the current name', async () => {
    const user = userEvent.setup();
    render(<ToolBuilderPanel mode="create" onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.type(screen.getByLabelText(/^name$/i), 'my-tool');
    const editor = await openCodeTab(user);
    expect(editor).toHaveValue(scaffoldToolTs('my-tool'));
  });

  it('resumes tracking the live scaffold after an edit is reverted, so a later rename regenerates it', async () => {
    const user = userEvent.setup();
    render(<ToolBuilderPanel mode="create" onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.type(screen.getByLabelText(/^name$/i), 'first-name');
    let editor = await openCodeTab(user);
    const firstScaffold = scaffoldToolTs('first-name');
    expect(editor).toHaveValue(firstScaffold);

    // Diverge, then revert to exactly the scaffold — the panel should
    // un-freeze and follow the live scaffold again.
    fireEvent.change(editor, { target: { value: `${firstScaffold}// extra` } });
    fireEvent.change(editor, { target: { value: firstScaffold } });

    await user.click(screen.getByRole('tab', { name: /details/i }));
    const nameInput = screen.getByLabelText(/^name$/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'second-name');

    editor = await openCodeTab(user);
    expect(editor).toHaveValue(scaffoldToolTs('second-name'));
  });

  it('a genuinely absent tool.ts (HTTP 404) degrades to an empty Code tab without losing Details editing', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: ['definition.json'],
      hasNodeModules: true,
      hasBuild: true,
      definition: existingDefinition,
    });
    // The server maps a genuinely-absent file to AppError NOT_FOUND → 404
    // (ToolWorkspaceService.readFile); only that status means "start empty".
    api.readFile.mockRejectedValue(new FetchError('File "tool.ts" not found', 404));
    const updatedTool = makeTool({ id: 'weather_lookup', name: 'weather-lookup' });
    api.updateFiles.mockResolvedValue({ workspace: {}, tool: updatedTool });

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={vi.fn()} onSaved={onSaved} />);

    // Details still loads and is editable (must not regress just because
    // tool.ts is absent out-of-band).
    const descriptionInput = await screen.findByDisplayValue('Old description');
    await user.type(descriptionInput, ' still editable');

    // The Code tab shows an empty editor rather than crashing the panel.
    const editor = await openCodeTab(user);
    expect(editor).toHaveValue('');

    // Saving without touching code stays metadata-only: no tool.ts write, no deploy.
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(api.updateFiles).toHaveBeenCalled());
    const [, files] = api.updateFiles.mock.calls[0] as [string, Record<string, string>];
    expect(Object.keys(files)).toEqual(['definition.json']);
    expect(api.deploy).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(updatedTool);
  });

  it('a transient (non-404) tool.ts load failure blocks Code editing and never writes tool.ts on save', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: ['definition.json', 'tool.ts'],
      hasNodeModules: true,
      hasBuild: true,
      definition: existingDefinition,
    });
    // A 500 (or network error) is NOT "file absent" — the file may well
    // exist. Presenting it as an empty editor would let a save full-file
    // overwrite the real tool.ts with content that never loaded.
    api.readFile.mockRejectedValue(new FetchError('Internal server error', 500));
    const updatedTool = makeTool({ id: 'weather_lookup', name: 'weather-lookup' });
    api.updateFiles.mockResolvedValue({ workspace: {}, tool: updatedTool });

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={vi.fn()} onSaved={onSaved} />);

    // Metadata stays editable.
    const descriptionInput = await screen.findByDisplayValue('Old description');
    await user.type(descriptionInput, ' still editable');

    // Code tab: visible load error, NO editor to type into.
    await user.click(screen.getByRole('tab', { name: /code/i }));
    expect(await screen.findByText(/couldn't load tool\.ts/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/tool\.ts handler code/i)).not.toBeInTheDocument();

    // Save still works, but is metadata-only: tool.ts is never included.
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(api.updateFiles).toHaveBeenCalled());
    const [, files] = api.updateFiles.mock.calls[0] as [string, Record<string, string>];
    expect(Object.keys(files)).toEqual(['definition.json']);
    expect(api.deploy).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(updatedTool);
  });

  it('Retry after a transient tool.ts load failure recovers the editor with the real content', async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: ['definition.json', 'tool.ts'],
      hasNodeModules: true,
      hasBuild: true,
      definition: existingDefinition,
    });
    api.readFile
      .mockRejectedValueOnce(new FetchError('Internal server error', 500))
      .mockResolvedValueOnce(ORIGINAL_TOOL_TS);

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByDisplayValue('Old description');

    await user.click(screen.getByRole('tab', { name: /code/i }));
    await screen.findByText(/couldn't load tool\.ts/i);

    await user.click(screen.getByRole('button', { name: /retry loading tool\.ts/i }));
    const editor = await screen.findByLabelText(/tool\.ts handler code/i);
    expect(editor).toHaveValue(ORIGINAL_TOOL_TS);
  });

  it('places the test console above the tool editor', async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: ['definition.json', 'tool.ts'],
      hasNodeModules: true,
      hasBuild: true,
      definition: existingDefinition,
    });
    api.readFile.mockResolvedValue(ORIGINAL_TOOL_TS);

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByDisplayValue('Old description');

    const editor = await openCodeTab(user);
    const testConsole = screen.getByRole('button', { name: /test console/i });

    expect(
      testConsole.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('editing metadata AND code together produces one updateFiles call carrying both', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    api.get.mockResolvedValue({
      toolId: 'weather-lookup',
      dir: '/tmp/weather-lookup',
      files: [],
      hasNodeModules: true,
      hasBuild: true,
      definition: existingDefinition,
    });
    api.readFile.mockResolvedValue(ORIGINAL_TOOL_TS);
    const updatedTool = makeTool({
      id: 'weather_lookup',
      name: 'weather-lookup',
      description: 'Brand new description',
    });
    api.updateFiles.mockResolvedValue({ workspace: {}, tool: updatedTool });
    const deployedTool = makeTool({ id: 'weather_lookup', name: 'weather-lookup', enabled: true });
    api.deploy.mockResolvedValue({
      success: true,
      tool: deployedTool,
      install: { success: true, output: '', durationMs: 1 },
      build: { success: true, output: '', durationMs: 1 },
    });

    render(<ToolBuilderPanel mode="edit" tool={existing} onClose={onClose} onSaved={onSaved} />);
    const descriptionInput = await screen.findByDisplayValue('Old description');
    await user.clear(descriptionInput);
    await user.type(descriptionInput, 'Brand new description');

    const editor = await openCodeTab(user);
    await user.type(editor, '// tweaked\n');

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(api.updateFiles).toHaveBeenCalled());
    const [calledId, files] = api.updateFiles.mock.calls[0] as [string, Record<string, string>];
    expect(calledId).toBe('weather-lookup');
    expect(Object.keys(files).sort()).toEqual(['definition.json', 'tool.ts']);
    expect(JSON.parse(files['definition.json']).description).toBe('Brand new description');
    expect(files['tool.ts']).toContain('// tweaked');

    await waitFor(() => expect(api.deploy).toHaveBeenCalledWith('weather-lookup'));
    expect(onSaved).toHaveBeenCalledWith(deployedTool);
    expect(onClose).toHaveBeenCalled();
  });
});
