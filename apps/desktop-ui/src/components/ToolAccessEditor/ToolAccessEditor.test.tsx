/**
 * ToolAccessEditor grouping — pins that the editor buckets tools by their
 * `categoryPath`, so native builtin toolboxes (e.g. `docs`, `files`) AND live
 * MCP servers (which arrive as `integrations/<serverId>`) each render as their
 * own group in one alphabetically-sorted list. This is the surface the
 * tool-access settings pane relies on to show native + MCP tools together.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolAccessEditor, type ToolOption } from './ToolAccessEditor';
import { CORE_TOOL_IDS } from '@snaglet/shared/constants';
import type { ToolAccessConfig } from '@snaglet/shared/types';

// A mix of native builtin tools (their own toolbox categoryPaths) and live MCP
// server tools (projected as `integrations/<serverId>`).
const TOOLS: ToolOption[] = [
  { id: 'doc', name: 'Get Doc', categoryPath: 'docs', description: 'Read a doc' },
  { id: 'edit_doc', name: 'Edit Doc', categoryPath: 'docs', description: 'Edit a doc' },
  { id: 'file_read', name: 'File Read', categoryPath: 'files', description: 'Read a file' },
  {
    id: 'mcp__notion__search',
    name: 'search',
    categoryPath: 'integrations/notion',
    description: 'Notion search',
  },
  {
    id: 'mcp__notion__fetch',
    name: 'fetch',
    categoryPath: 'integrations/notion',
    description: 'Notion fetch',
  },
];

// deny_list mode renders the grouped tool list (mode 'all' hides it).
const DENY_MODE: ToolAccessConfig = { mode: 'deny_list', allowList: [], denyList: [] };

function renderEditor(tools: ToolOption[] = TOOLS) {
  return render(<ToolAccessEditor value={DENY_MODE} tools={tools} onSave={vi.fn()} />);
}

describe('ToolAccessEditor grouping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders one group per categoryPath, including MCP servers alongside native toolboxes', () => {
    renderEditor();

    // Native toolbox groups.
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('files')).toBeInTheDocument();
    // MCP-server group (projected category) sits in the same list.
    expect(screen.getByText('integrations/notion')).toBeInTheDocument();

    // Both native and MCP tools are checkable rows.
    expect(screen.getByText('Get Doc')).toBeInTheDocument();
    expect(screen.getByText('search')).toBeInTheDocument();
    expect(screen.getByText('fetch')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(TOOLS.length);
  });

  it('groups are sorted by categoryPath and each group holds its own tools', () => {
    renderEditor();

    const labels = screen
      .getAllByText(/^(docs|files|integrations\/notion)$/)
      .map((el) => el.textContent);
    // Alphabetical: docs < files < integrations/notion.
    expect(labels).toEqual(['docs', 'files', 'integrations/notion']);

    // The MCP group contains exactly its two server tools, not any native ones.
    // The label's parent is the group container (label + its tool rows).
    const mcpGroup = screen.getByText('integrations/notion').parentElement;
    expect(mcpGroup).not.toBeNull();
    const scoped = within(mcpGroup as HTMLElement);
    expect(scoped.getByText('search')).toBeInTheDocument();
    expect(scoped.getByText('fetch')).toBeInTheDocument();
    expect(scoped.queryByText('Get Doc')).toBeNull();
  });

  it('filters across name and categoryPath so an MCP server can be isolated by its category', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText('Search tools'), 'integrations/notion');

    // MCP group survives; native toolbox groups are filtered out.
    expect(screen.getByText('integrations/notion')).toBeInTheDocument();
    expect(screen.getByText('search')).toBeInTheDocument();
    expect(screen.queryByText('docs')).toBeNull();
    expect(screen.queryByText('Get Doc')).toBeNull();
  });

  it('moves tool descriptions and exposure details into shared help tooltips', async () => {
    renderEditor();

    expect(screen.queryByText('on demand')).toBeNull();
    expect(screen.queryByText('Read a doc')).toBeNull();

    screen.getByRole('button', { name: 'About Get Doc' }).focus();
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Read a doc'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(/advertised every turn/i);

    await userEvent.setup().keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('explains that allow-listed on-demand tools are pinned into every turn', () => {
    render(
      <ToolAccessEditor
        value={{ mode: 'allow_list', allowList: [], denyList: [] }}
        tools={TOOLS}
        onSave={vi.fn()}
      />
    );

    expect(screen.getByText(/selected on-demand tools are pinned into every turn/i)).toBeVisible();
  });

  it('explains the core-versus-discoverable split in all-tools mode', () => {
    render(
      <ToolAccessEditor
        value={{ mode: 'all', allowList: [], denyList: [] }}
        tools={TOOLS}
        onSave={vi.fn()}
      />
    );

    expect(
      screen.getByText(
        new RegExp(`${CORE_TOOL_IDS.size} core tools are advertised every turn`, 'i')
      )
    ).toBeVisible();
    expect(screen.getByText(/the rest are discovered on demand/i)).toBeVisible();
  });
});
