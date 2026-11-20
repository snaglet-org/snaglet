/**
 * Chat tool-call rows show canonical tool ids. A call logged under an alias id
 * (`exec_command`) reads as its canonical id (`shell`) with a
 * "was exec_command" hint. A merged tool's op reads beside the id
 * (`shell(op:run)`).
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { ActivityDisclosure } from './ActivityDisclosure';
import type { RunActivity } from '../hooks/types';

function toolStep(id: string, toolName: string, input: Record<string, unknown> = {}) {
  return {
    kind: 'tool_call' as const,
    id,
    toolName,
    input,
    output: 'ok',
    success: true,
    durationMs: 3,
    status: 'done' as const,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

type ToolStep = ReturnType<typeof toolStep>;

function renderRun(...steps: Array<ToolStep | (Omit<ToolStep, 'status'> & { status: 'running' })>) {
  const activity: RunActivity = {
    runId: 'run-1',
    agentId: 'test-agent-a',
    threadId: 'thread-1',
    steps,
    status: 'complete',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:05Z',
  };
  return render(<ActivityDisclosure activity={activity} agentName="Test Agent" />);
}

describe('ActivityDisclosure — tool names', () => {
  it('shows a call logged under an old id as its canonical tool, with a hint', () => {
    renderRun(toolStep('s1', 'exec_command'));

    expect(screen.getByText('shell')).toBeInTheDocument();
    expect(screen.getByText('was exec_command')).toBeInTheDocument();
    expect(screen.queryByText('exec_command')).toBeNull();
  });

  it('maps old ids inside a bundle and behind the action gateway prefix', () => {
    renderRun(toolStep('s1', 'get_node'), toolStep('s2', 'action__file_read'));

    expect(screen.getByText('node')).toBeInTheDocument();
    expect(screen.getByText('was get_node')).toBeInTheDocument();
    expect(screen.getByText('action__file')).toBeInTheDocument();
    expect(screen.getByText('was file_read')).toBeInTheDocument();
  });

  it('shows Ask for the historical get_clarification id, with a hint', () => {
    renderRun(toolStep('s1', 'get_clarification'));

    expect(screen.getByText('ask')).toBeInTheDocument();
    expect(screen.getByText('was get_clarification')).toBeInTheDocument();
    expect(screen.queryByText(/^get_clarification$/)).toBeNull();
  });

  it('leaves canonical, MCP and removed ids as they are', () => {
    renderRun(
      toolStep('s1', 'shell'),
      toolStep('s2', 'mcp__notion__search'),
      toolStep('s3', 'sandbox_run')
    );

    expect(screen.getByText('shell')).toBeInTheDocument();
    expect(screen.getByText('mcp__notion__search')).toBeInTheDocument();
    expect(screen.getByText('sandbox_run')).toBeInTheDocument();
    expect(screen.queryByText(/^was /)).toBeNull();
  });
});

describe('ActivityDisclosure — tool ops', () => {
  /** The name cell of the row whose tool id reads `id`. */
  const nameCell = (id: string) => screen.getByText(id).closest('span') as HTMLElement;

  it('shows the op a call ran next to its tool id', () => {
    renderRun(toolStep('s1', 'shell', { op: 'run', command: 'ls' }));

    expect(nameCell('shell')).toHaveTextContent(/^shell\(op:run\)$/);
    expect(nameCell('shell')).toHaveAttribute('title', 'shell(op:run)');
  });

  it('leaves a call without an op as the bare id', () => {
    renderRun(
      toolStep('s1', 'web_search', { query: 'test' }),
      toolStep('s2', 'doc', { op: '  ' }),
      toolStep('s3', 'memory', { op: 3 })
    );

    expect(nameCell('web_search')).toHaveTextContent(/^web_search$/);
    expect(nameCell('doc')).toHaveTextContent(/^doc$/);
    expect(nameCell('memory')).toHaveTextContent(/^memory$/);
    expect(screen.queryByText(/\(op:/)).toBeNull();
  });

  it('shows the op on a running call, in a bundle and behind the action gateway', () => {
    renderRun(
      { ...toolStep('s1', 'file', { op: 'read', path: 'a.txt' }), status: 'running' },
      toolStep('s2', 'action__node', { op: 'move' })
    );

    expect(nameCell('file')).toHaveTextContent(/^file\(op:read\)$/);
    expect(nameCell('action__node')).toHaveTextContent(/^action__node\(op:move\)$/);
  });

  it('shows the op an old id pins, before its "was …" hint', () => {
    renderRun(toolStep('s1', 'exec_command', { command: 'ls' }));

    expect(nameCell('shell')).toHaveTextContent(/^shell\(op:run\)was exec_command$/);
    expect(nameCell('shell')).toHaveAttribute('title', 'shell(op:run) (was exec_command)');
  });

  it("prefers the old id's pinned op over one in its input, as the call ran", () => {
    renderRun(toolStep('s1', 'memory_forget', { op: 'search' }));

    expect(nameCell('memory')).toHaveTextContent(/^memory\(op:delete\)was memory_forget$/);
  });
});
