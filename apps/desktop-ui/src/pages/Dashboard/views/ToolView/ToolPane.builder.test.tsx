/**
 * ToolPane with the real ToolBuilderPanel inside it. ToolPane.test.tsx stubs
 * the builder; this file pins the handshake between the two as it runs in the
 * app: the builder's submit calls `onSaved` and then `onClose` in the same
 * tick, before ToolPane re-renders with the saved tool. Only the API client
 * and the view face (ToolView, with its own suite) are stubbed.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  return { ...actual, toolWorkspacesApi: api };
});

vi.mock('./ToolView.js', () => ({
  ToolView: ({ tool }: { tool: ToolRow }) => (
    <div data-testid="tool-view">
      {tool.name}:{tool.description}
    </div>
  ),
}));

import { ToolPane } from './ToolPane';

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

const deployed = makeTool({
  id: 'tool-a',
  name: 'test-tool-a',
  source: 'workspace:test-tool-a',
  description: 'Looks things up',
});

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
});

describe('ToolPane with the real builder', () => {
  it('Create tool lands on the new tool, not on its edit form', async () => {
    const user = userEvent.setup();
    const onReplaceSelection = vi.fn();
    api.save.mockResolvedValue({ workspace: {}, tool: { ...deployed, enabled: false } });
    api.deploy.mockResolvedValue({
      success: true,
      tool: deployed,
      install: { success: true, output: '', durationMs: 1 },
      build: { success: true, output: '', durationMs: 1 },
    });

    render(<ToolPane create onReplaceSelection={onReplaceSelection} />);

    await user.type(screen.getByLabelText(/^name$/i), 'test-tool-a');
    await user.click(screen.getByRole('button', { name: /create tool/i }));

    await waitFor(() => expect(onReplaceSelection).toHaveBeenCalledTimes(1));
    expect(onReplaceSelection).toHaveBeenCalledWith({ kind: 'tool', tool: deployed });
    expect(screen.getByTestId('tool-view')).toHaveTextContent('test-tool-a:Looks things up');
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('a failed create keeps the New tool form open with its error', async () => {
    const user = userEvent.setup();
    const onReplaceSelection = vi.fn();
    api.save.mockResolvedValue({ workspace: {}, tool: { ...deployed, enabled: false } });
    api.deploy.mockResolvedValue({
      success: false,
      step: 'build',
      output: 'esbuild output',
      error: 'tool.ts:3:1 Unexpected token',
      durationMs: 1,
    });

    render(<ToolPane create onReplaceSelection={onReplaceSelection} />);

    await user.type(screen.getByLabelText(/^name$/i), 'test-tool-a');
    await user.click(screen.getByRole('button', { name: /create tool/i }));

    expect(await screen.findByText(/tool\.ts:3:1 unexpected token/i)).toBeInTheDocument();
    expect(screen.getByText('New tool')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create tool/i })).toBeEnabled();
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('test-tool-a');
    expect(screen.queryByTestId('tool-view')).not.toBeInTheDocument();
    expect(onReplaceSelection).not.toHaveBeenCalled();
  });

  it('Save changes on an existing tool returns to its view face with the saved data', async () => {
    const user = userEvent.setup();
    const onReplaceSelection = vi.fn();
    api.get.mockResolvedValue({
      toolId: 'test-tool-a',
      dir: '/tmp/test-tool-a',
      files: [],
      hasNodeModules: true,
      hasBuild: true,
      definition: {
        name: 'test-tool-a',
        description: 'Looks things up',
        categoryPath: 'custom',
        providerId: null,
        tier: 'standard',
        parametersSchema: {},
        keywords: [],
      },
    });
    api.readFile.mockResolvedValue('export default async function handler() {}\n');
    api.updateFiles.mockResolvedValue({
      workspace: {},
      tool: { ...deployed, description: 'Looks more things up' },
    });

    render(<ToolPane tool={deployed} startEditing onReplaceSelection={onReplaceSelection} />);

    const description = await screen.findByDisplayValue('Looks things up');
    await user.clear(description);
    await user.type(description, 'Looks more things up');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByTestId('tool-view')).toHaveTextContent(
      'test-tool-a:Looks more things up'
    );
    expect(onReplaceSelection).not.toHaveBeenCalled();
  });
});
