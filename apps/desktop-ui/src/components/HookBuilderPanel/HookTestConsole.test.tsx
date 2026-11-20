/**
 * HookTestConsole — the hook builder's trigger-aware test surface. Pins the
 * console's orchestration (the chip editor itself is covered by its own
 * suite and is mocked to a textarea here, same pattern as
 * HookBuilderPanel.test.tsx):
 *
 *   - The trigger picker lists exactly the events parsed from the live
 *     editor code, and each trigger renders the input it needs
 *     (TRIGGER_PARAM_SPECS): chip entity, raw run id, or nothing.
 *   - Run flow = ensureSaved → check → run, with stdout/stderr/exit/duration
 *     rendered in the log.
 *   - A check/build failure surfaces in the console and never reaches run.
 *   - Kind-mismatched chips and missing required entities fail locally
 *     without a server call.
 *   - "Trigger now" renders for a schedule (parsed live or declared) and
 *     fires a synthesized due-now schedule:fire with the real schedule id.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const hooksApi = vi.hoisted(() => ({ check: vi.fn(), run: vi.fn() }));
const schedulesApi = vi.hoisted(() => ({
  list: vi.fn(),
  setEnabled: vi.fn(),
  runNow: vi.fn(),
  runs: vi.fn(),
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    hooksWorkspacesApi: { ...actual.hooksWorkspacesApi, ...hooksApi },
    schedulesApi,
  };
});

// TipTap is jsdom-hostile; the chip editor has its own suite. A textarea
// stand-in keeps the value→extractNodeRefs→run plumbing real.
vi.mock('@desktop/features/rich-markdown/editor/index.js', () => ({
  ChipEditableInput: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (next: string) => void;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

import { resetTestConsoleEntriesForTests } from '@desktop/components/BuilderTestConsole/testConsoleEntries';
import { HookTestConsole } from './HookTestConsole';

const codeWith = (on: string, extra = '') =>
  `import { defineHook, snaglet } from '@snaglet/sdk';
export default defineHook({
  on: ${on},
${extra}  async run(event) {},
});
`;

const MESSAGE_HOOK = codeWith(`'message:create'`);

const READY_CHECK = {
  registration: {
    id: 'hook_1',
    name: 'my-hook',
    sourcePath: '/hooks/my-hook/hook.ts',
    enabled: true,
    buildStatus: 'ready' as const,
    lastError: null,
    builtPath: '/builds/my-hook/hook.cjs',
    lastBuiltAt: null,
    createdAt: '',
    updatedAt: '',
  },
  declared: { events: ['message:create'], filter: null, schedules: [] as unknown[] },
};

const OK_RUN = {
  runs: [
    {
      nodeId: null,
      eventName: 'message:create',
      event: { id: 'message-1', threadId: 'thread-1' },
      result: {
        ok: true,
        exitCode: 0,
        durationMs: 42,
        stdout: 'hello from hook',
        stderr: 'warn: something odd',
        timedOut: false,
      },
    },
  ],
};

async function expandConsole() {
  await userEvent.setup().click(screen.getByRole('button', { name: /test console/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // The entry store is module-level (history survives remounts by design) —
  // reset it so one case's run log can't leak into the next.
  resetTestConsoleEntriesForTests();
  hooksApi.check.mockResolvedValue(READY_CHECK);
  hooksApi.run.mockResolvedValue(OK_RUN);
  schedulesApi.list.mockResolvedValue([]);
});

describe('HookTestConsole trigger-aware inputs', () => {
  it('lists exactly the events parsed from the live code, defaulting to the first', async () => {
    render(
      <HookTestConsole
        hookName="my-hook"
        code={codeWith(`['run:end', 'message:create']`)}
        ensureSaved={vi.fn()}
      />
    );
    await expandConsole();

    expect(screen.getByRole('region', { name: 'Test console' })).toBeInTheDocument();
    const picker = screen.getByLabelText('Test trigger') as HTMLSelectElement;
    expect(picker.value).toBe('run:end');
    const labels = Array.from(picker.options).map((option) => option.textContent);
    expect(labels).toEqual(['Agent run ended', 'Message created']);
  });

  it('falls back to every event when the code declares no on:', async () => {
    render(<HookTestConsole hookName="my-hook" code="const x = 1;" ensureSaved={vi.fn()} />);
    await expandConsole();

    const picker = screen.getByLabelText('Test trigger') as HTMLSelectElement;
    expect(picker.options.length).toBeGreaterThan(4);
    expect(screen.getByText(/no `on:` triggers detected/i)).toBeInTheDocument();
  });

  it('message:create renders a Message chip input; schedule:fire renders no entity input', async () => {
    render(
      <HookTestConsole
        hookName="my-hook"
        code={codeWith(`['message:create', 'schedule:fire']`)}
        ensureSaved={vi.fn()}
      />
    );
    await expandConsole();
    expect(screen.getByLabelText('Message ID for the test event')).toBeInTheDocument();

    await userEvent.setup().selectOptions(screen.getByLabelText('Test trigger'), 'schedule:fire');
    expect(screen.queryByLabelText(/for the test event/)).not.toBeInTheDocument();
    expect(screen.getByText(/due-now schedule payload/i)).toBeInTheDocument();
  });

  it('run:end renders a plain Run ID field and sends it as the nodeId', async () => {
    render(
      <HookTestConsole hookName="my-hook" code={codeWith(`'run:end'`)} ensureSaved={vi.fn()} />
    );
    await expandConsole();

    fireEvent.change(screen.getByLabelText('Run ID for the test event'), {
      target: { value: 'run-1111111111111-abc12' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(hooksApi.run).toHaveBeenCalledTimes(1));
    expect(hooksApi.run).toHaveBeenCalledWith(
      'my-hook',
      expect.objectContaining({ nodeIds: ['run-1111111111111-abc12'], eventName: 'run:end' })
    );
  });

  it('table_entry:update renders Table ID + Entry ID fields and sends them as tableId/entryId', async () => {
    render(
      <HookTestConsole
        hookName="my-hook"
        code={codeWith(`'table_entry:update'`)}
        ensureSaved={vi.fn()}
      />
    );
    await expandConsole();

    fireEvent.change(screen.getByLabelText('Table ID for the test event'), {
      target: { value: 'table-1111111111111-aaaaaaaaa' },
    });
    fireEvent.change(screen.getByLabelText('Entry ID for the test event'), {
      target: { value: '00000000-0000-4000-8000-000000000001' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(hooksApi.run).toHaveBeenCalledTimes(1));
    expect(hooksApi.run).toHaveBeenCalledWith(
      'my-hook',
      expect.objectContaining({
        tableId: 'table-1111111111111-aaaaaaaaa',
        entryId: '00000000-0000-4000-8000-000000000001',
        eventName: 'table_entry:update',
      })
    );
  });

  it('table_entry:occurrence takes a table and a repeating row and sends that event name', async () => {
    render(
      <HookTestConsole
        hookName="my-hook"
        code={codeWith(`'table_entry:occurrence'`)}
        ensureSaved={vi.fn()}
      />
    );
    await expandConsole();

    fireEvent.change(screen.getByLabelText('Table ID for the test event'), {
      target: { value: 'table-1111111111111-aaaaaaaaa' },
    });
    fireEvent.change(screen.getByLabelText('Entry ID for the test event'), {
      target: { value: '00000000-0000-4000-8000-000000000001' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(hooksApi.run).toHaveBeenCalledTimes(1));
    expect(hooksApi.run).toHaveBeenCalledWith(
      'my-hook',
      expect.objectContaining({
        tableId: 'table-1111111111111-aaaaaaaaa',
        entryId: '00000000-0000-4000-8000-000000000001',
        eventName: 'table_entry:occurrence',
      })
    );
  });

  it('a run chip dropped on the Run ID field inserts the BARE id, not chip markdown', async () => {
    render(
      <HookTestConsole hookName="my-hook" code={codeWith(`'run:end'`)} ensureSaved={vi.fn()} />
    );
    await expandConsole();

    const field = screen.getByLabelText('Run ID for the test event');
    // Run ids are bare randomUUID() values (turnLoop.ts) — no `run-` prefix.
    const chip = {
      id: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      kind: 'run',
      title: 'mango',
    };
    // Minimal DataTransfer stand-in: jsdom's drop events carry no real one.
    const dataTransfer = {
      getData: (type: string) =>
        type === 'application/x-snaglet-node-chip' ? JSON.stringify(chip) : '',
      types: ['application/x-snaglet-node-chip'],
      dropEffect: 'none',
    };

    fireEvent.drop(field, { dataTransfer });

    // The id branch feeds paramValue straight through as a node id, so chip
    // markdown here would be sent verbatim and fail server-side.
    await waitFor(() => expect((field as HTMLInputElement).value).toBe(chip.id));
    expect((field as HTMLInputElement).value).not.toContain('[');

    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(hooksApi.run).toHaveBeenCalledTimes(1));
    expect(hooksApi.run).toHaveBeenCalledWith(
      'my-hook',
      expect.objectContaining({ nodeIds: [chip.id], eventName: 'run:end' })
    );
  });

  it('sends the message id from a dropped/mentioned chip to the run endpoint', async () => {
    render(<HookTestConsole hookName="my-hook" code={MESSAGE_HOOK} ensureSaved={vi.fn()} />);
    await expandConsole();
    await waitFor(() => expect(hooksApi.check).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Message ID for the test event'), {
      target: { value: '[Hi there](message-1111111111111-a1yzyhggz)' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(hooksApi.run).toHaveBeenCalledTimes(1));
    expect(hooksApi.run).toHaveBeenCalledWith(
      'my-hook',
      expect.objectContaining({
        nodeIds: ['message-1111111111111-a1yzyhggz'],
        eventName: 'message:create',
      })
    );
  });

  it('rejects a kind-mismatched chip locally without calling the server', async () => {
    render(<HookTestConsole hookName="my-hook" code={MESSAGE_HOOK} ensureSaved={vi.fn()} />);
    await expandConsole();

    fireEvent.change(screen.getByLabelText('Message ID for the test event'), {
      target: { value: '[My doc](doc-1111111111111-a1yzyhggz)' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    expect(await screen.findByText(/doc link can't fire message:create/i)).toBeInTheDocument();
    expect(hooksApi.run).not.toHaveBeenCalled();
  });

  it('requires the entity when the input and JSON are both empty — no server call', async () => {
    const ensureSaved = vi.fn();
    render(<HookTestConsole hookName="my-hook" code={MESSAGE_HOOK} ensureSaved={ensureSaved} />);
    await expandConsole();

    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    expect(await screen.findByText(/message id is required/i)).toBeInTheDocument();
    expect(hooksApi.run).not.toHaveBeenCalled();
    expect(ensureSaved).not.toHaveBeenCalled();
  });

  it('passes plain non-chip text through as raw ids (agent slugs)', async () => {
    render(
      <HookTestConsole hookName="my-hook" code={codeWith(`'agent:update'`)} ensureSaved={vi.fn()} />
    );
    await expandConsole();

    fireEvent.change(screen.getByLabelText('Agent ID for the test event'), {
      target: { value: 'clio' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(hooksApi.run).toHaveBeenCalledTimes(1));
    expect(hooksApi.run).toHaveBeenCalledWith(
      'my-hook',
      expect.objectContaining({ nodeIds: ['clio'], eventName: 'agent:update' })
    );
  });
});

describe('HookTestConsole run flow', () => {
  it('saves, checks, runs, and renders stdout/stderr/exit/duration for the run', async () => {
    const ensureSaved = vi.fn().mockResolvedValue(undefined);
    render(
      <HookTestConsole
        hookName="my-hook"
        code={codeWith(`'schedule:fire'`)}
        ensureSaved={ensureSaved}
      />
    );
    await expandConsole();
    await waitFor(() => expect(hooksApi.check).toHaveBeenCalledTimes(1));

    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => expect(hooksApi.run).toHaveBeenCalledTimes(1));
    expect(ensureSaved).toHaveBeenCalled();
    // Run flow re-checks (build failures are the most common mistake).
    expect(hooksApi.check).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('hello from hook')).toBeInTheDocument();
    expect(screen.getByText('warn: something odd')).toBeInTheDocument();
    expect(screen.getByText(/exit 0/)).toBeInTheDocument();
    expect(screen.getByText(/42ms/)).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  it('surfaces a check/build failure in the console and never calls run', async () => {
    render(
      <HookTestConsole
        hookName="my-hook"
        code={codeWith(`'schedule:fire'`)}
        ensureSaved={vi.fn()}
      />
    );
    await expandConsole();
    await waitFor(() => expect(hooksApi.check).toHaveBeenCalledTimes(1));

    hooksApi.check.mockResolvedValue({
      registration: {
        ...READY_CHECK.registration,
        buildStatus: 'failed' as const,
        lastError: 'hook.ts(3): Unexpected token',
      },
      declared: null,
    });
    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    expect(await screen.findAllByText(/Unexpected token/)).not.toHaveLength(0);
    expect(screen.getByText('fail')).toBeInTheDocument();
    expect(hooksApi.run).not.toHaveBeenCalled();
  });

  it('shows the resolved payload in the JSON editor after an entity run', async () => {
    render(<HookTestConsole hookName="my-hook" code={MESSAGE_HOOK} ensureSaved={vi.fn()} />);
    await expandConsole();
    await waitFor(() => expect(hooksApi.check).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Message ID for the test event'), {
      target: { value: '[Hi](message-1111111111111-a1yzyhggz)' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/raw event json/i)).toHaveValue(
        JSON.stringify(OK_RUN.runs[0].event, null, 2)
      );
    });
  });

  it('rejects malformed event JSON locally without calling the server', async () => {
    const ensureSaved = vi.fn();
    render(
      <HookTestConsole
        hookName="my-hook"
        code={codeWith(`'schedule:fire'`)}
        ensureSaved={ensureSaved}
      />
    );
    await expandConsole();
    await waitFor(() => expect(hooksApi.check).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/raw event json/i), {
      target: { value: '{ not json' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: /run test/i }));

    expect(await screen.findByText(/must be a single object/i)).toBeInTheDocument();
    expect(hooksApi.run).not.toHaveBeenCalled();
    expect(ensureSaved).not.toHaveBeenCalled();
  });
});

describe('HookTestConsole Trigger now', () => {
  it('is hidden when neither the code nor the saved declaration has a schedule', async () => {
    render(<HookTestConsole hookName="my-hook" code={MESSAGE_HOOK} ensureSaved={vi.fn()} />);
    await expandConsole();
    await waitFor(() => expect(hooksApi.check).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: /trigger now/i })).not.toBeInTheDocument();
  });

  it('renders for a LIVE schedule: in the editor code (before any check)', async () => {
    render(
      <HookTestConsole
        hookName="my-hook"
        code={codeWith(`'message:create'`, `  schedule: [{ every: 15, unit: 'minute' }],\n`)}
        ensureSaved={vi.fn()}
      />
    );
    await expandConsole();
    expect(await screen.findByRole('button', { name: /trigger now/i })).toBeInTheDocument();
  });

  it('fires a due-now schedule:fire with the real registered schedule id', async () => {
    hooksApi.check.mockResolvedValue({
      ...READY_CHECK,
      declared: { events: [], filter: null, schedules: [{ every: 15, unit: 'minute' }] },
    });
    schedulesApi.list.mockResolvedValue([
      {
        id: 'schedule-real-1',
        name: 'my-hook schedule',
        enabled: true,
        actionKind: 'hook',
        action: { hookName: 'my-hook' },
      },
    ]);
    render(
      <HookTestConsole
        hookName="my-hook"
        code={codeWith(`'message:create'`, `  schedule: [{ every: 15, unit: 'minute' }],\n`)}
        ensureSaved={vi.fn()}
      />
    );
    await expandConsole();

    const trigger = await screen.findByRole('button', { name: /trigger now/i });
    // The schedule-id lookup is async — wait for it to land before firing.
    await waitFor(() => expect(schedulesApi.list).toHaveBeenCalled());
    await userEvent.setup().click(trigger);

    await waitFor(() => expect(hooksApi.run).toHaveBeenCalledTimes(1));
    const [hookName, input] = hooksApi.run.mock.calls[0] as [
      string,
      { eventName?: string; event?: Record<string, unknown> },
    ];
    expect(hookName).toBe('my-hook');
    expect(input.eventName).toBe('schedule:fire');
    expect(input.event).toEqual(
      expect.objectContaining({
        scheduleId: 'schedule-real-1',
        runId: expect.stringMatching(/^test-\d+$/),
        scheduledFor: expect.any(String),
      })
    );
  });
});
