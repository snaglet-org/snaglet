/**
 * The tool page right after Create tool, with the real builder and the real
 * view face. The other ToolPane suites stub ToolView and hand it fully
 * decorated rows, so they cannot see what the view does with the row deploy
 * actually returns. Only the API client is stubbed, plus the chip input a
 * string parameter renders, which needs layout APIs jsdom lacks.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolRow as PersistedToolRow } from '@snaglet/shared/types';
import { ErrorBoundary } from '@desktop/components';

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

vi.mock('@desktop/features/rich-markdown/editor/index.js', () => ({
  ChipEditableInput: () => <div data-testid="chip-editable-input" />,
}));

import { ToolPane } from './ToolPane';
import { ToolView } from './ToolView';

/**
 * A fresh custom tool as `syncDefinitionToDb` (apps/server/src/domains/tools/
 * routes/helpers.ts) writes it from the builder's definition.json: the bare
 * `tools` row, with none of the read-time decoration (`availability`,
 * execution metadata) the list and get routes add.
 */
const weatherRow: PersistedToolRow = {
  id: 'weather',
  name: 'weather',
  description: "Today's weather for a place: high, low, sunrise, sunset, UV and air quality.",
  type: 'external',
  categoryPath: 'custom',
  providerId: null,
  tier: 'standard',
  parametersSchema: { type: 'object', properties: { place: { type: 'string' } } },
  keywords: ['weather', 'local'],
  aliases: [],
  source: 'workspace:weather',
  sortOrder: 0,
  enabled: true,
  configJson: {
    workspace_tool: true,
    workspace_dir: 'tool-workspaces/weather',
    built_path: 'tool-workspaces/weather/dist/tool.cjs',
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
});

describe('the tool page right after Create tool', () => {
  it('opens on the new tool instead of the error panel', async () => {
    const user = userEvent.setup();
    api.save.mockResolvedValue({ workspace: {}, tool: { ...weatherRow, enabled: false } });
    api.deploy.mockResolvedValue({
      success: true,
      tool: weatherRow,
      install: { success: true, output: '', durationMs: 1 },
      build: { success: true, output: '', durationMs: 1 },
    });

    render(
      <ErrorBoundary>
        <ToolPane create onReplaceSelection={vi.fn()} />
      </ErrorBoundary>
    );

    await user.type(screen.getByLabelText(/^name$/i), 'weather');
    await user.click(screen.getByRole('button', { name: /create tool/i }));

    await waitFor(() => expect(api.deploy).toHaveBeenCalledWith('weather'));
    expect(await screen.findByRole('heading', { name: 'weather' })).toBeInTheDocument();
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /disable tool for all agents/i })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
  });

  it('treats a row without availability as available when enabled and disabled when not', () => {
    const { unmount } = render(<ToolView tool={weatherRow} />);
    expect(screen.getByRole('heading', { name: 'weather' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
    unmount();

    render(<ToolView tool={{ ...weatherRow, enabled: false }} />);
    expect(screen.getByRole('switch', { name: /enable tool for all agents/i })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });
});
