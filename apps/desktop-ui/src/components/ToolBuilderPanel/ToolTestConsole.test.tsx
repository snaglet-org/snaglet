/**
 * ToolTestConsole — the tool builder's test surface (shared shell with the
 * hook console). Pins:
 *
 *   - The args editor is pre-seeded from `parametersSchema` (defaults /
 *     empty-by-type skeleton) and can be re-seeded on demand.
 *   - Run sends the current editor code + parsed args to
 *     `toolsApi.test` (the /tools/execute/test sandbox) and renders
 *     output/error/duration with an ok/fail badge.
 *   - A nested tool call the sandbox refuses (test runs act as ghost, gated
 *     by ghost's allow list) renders a friendly explanation, not just the
 *     raw stderr.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const toolsApi = vi.hoisted(() => ({ test: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, toolsApi: { ...actual.toolsApi, ...toolsApi } };
});

import { ToolTestConsole } from './ToolTestConsole';

const SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
    limit: { type: 'number', default: 5 },
    exact: { type: 'boolean' },
  },
  required: ['query'],
};

const CODE = 'export default async function handler(input) { return input; }';

async function expandConsole() {
  await userEvent.setup().click(screen.getByRole('button', { name: /test console/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  toolsApi.test.mockResolvedValue({ success: true, output: '{"echo":true}', durationMs: 21 });
});

describe('ToolTestConsole args seeding', () => {
  it('pre-seeds the JSON editor from the parameters schema (defaults + empty-by-type)', async () => {
    render(<ToolTestConsole toolName="my-tool" code={CODE} parametersSchema={SCHEMA} />);
    await expandConsole();

    const editor = screen.getByLabelText(/tool input json/i);
    expect(JSON.parse((editor as HTMLTextAreaElement).value)).toEqual({
      query: '',
      limit: 5,
      exact: false,
    });
  });

  it('re-seeds on demand after the user mangles the JSON', async () => {
    render(<ToolTestConsole toolName="my-tool" code={CODE} parametersSchema={SCHEMA} />);
    await expandConsole();

    fireEvent.change(screen.getByLabelText(/tool input json/i), {
      target: { value: 'scribbles' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: /re-seed from schema/i }));

    const editor = screen.getByLabelText(/tool input json/i) as HTMLTextAreaElement;
    expect(JSON.parse(editor.value)).toEqual({ query: '', limit: 5, exact: false });
  });
});

describe('ToolTestConsole notice', () => {
  it('says test runs make real SDK calls as the ghost system actor', async () => {
    render(<ToolTestConsole toolName="my-tool" code={CODE} parametersSchema={null} />);
    await expandConsole();

    expect(
      screen.getByText(/@snaglet\/sdk calls are real and act as the ghost system actor/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/disabled in test runs/i)).not.toBeInTheDocument();
  });
});

describe('ToolTestConsole run flow', () => {
  it('runs the current editor code with the parsed args and renders the output', async () => {
    render(<ToolTestConsole toolName="my-tool" code={CODE} parametersSchema={SCHEMA} />);
    await expandConsole();

    fireEvent.change(screen.getByLabelText(/tool input json/i), {
      target: { value: '{ "query": "docs" }' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(toolsApi.test).toHaveBeenCalledTimes(1));
    expect(toolsApi.test).toHaveBeenCalledWith(CODE, { query: 'docs' });
    expect(await screen.findByText('{"echo":true}')).toBeInTheDocument();
    expect(screen.getByText(/21ms/)).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  it('renders a failed run with the error stream visually present', async () => {
    toolsApi.test.mockResolvedValue({
      success: false,
      output: '',
      error: 'Build failed:\nUnexpected token (3:1)',
      durationMs: 9,
    });
    render(<ToolTestConsole toolName="my-tool" code={CODE} parametersSchema={null} />);
    await expandConsole();

    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    expect(await screen.findByText(/Unexpected token/)).toBeInTheDocument();
    expect(screen.getByText('fail')).toBeInTheDocument();
  });

  it("translates a nested call outside ghost's allow list into a friendly explanation", async () => {
    toolsApi.test.mockResolvedValue({
      success: false,
      output: '',
      // What the sandbox's @snaglet/sdk (the deployed runtime) throws on a refusal.
      error:
        'Snaglet server returned 403: {"success":false,"error":{"code":"FORBIDDEN","message":' +
        '"Blocked by tool-access policy: `other_tool` is not in this agent\'s tool list."}}',
      durationMs: 15,
    });
    render(<ToolTestConsole toolName="my-tool" code={CODE} parametersSchema={null} />);
    await expandConsole();

    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    expect(await screen.findByText(/test runs act as the ghost system actor/i)).toBeInTheDocument();
    // The raw stderr stays available too — the note explains, never hides.
    expect(screen.getByText(/Blocked by tool-access policy/)).toBeInTheDocument();
  });

  it('rejects malformed args JSON locally without calling the sandbox', async () => {
    render(<ToolTestConsole toolName="my-tool" code={CODE} parametersSchema={null} />);
    await expandConsole();

    fireEvent.change(screen.getByLabelText(/tool input json/i), {
      target: { value: '[1, 2]' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    expect(await screen.findByText(/must be a single object/i)).toBeInTheDocument();
    expect(toolsApi.test).not.toHaveBeenCalled();
  });
});
