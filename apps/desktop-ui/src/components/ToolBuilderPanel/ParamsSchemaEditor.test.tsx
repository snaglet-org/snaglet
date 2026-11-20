/**
 * ParamsSchemaEditor — the row-based UI over ParamFieldRow[] (name/type/
 * required/description/enum-values), used by ToolBuilderPanel to build a
 * `parametersSchema` without hand-writing JSON. The actual JSON-Schema
 * assembly is scaffold.ts's job (see scaffold.test.ts); this file only pins
 * the editor's own wiring — add/remove/edit rows call `onChange` with the
 * right next array.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// The `@desktop/components` barrel's transitive tree reads Vite env vars
// (client config) at import time — stub before importing anything that pulls
// it in (matches ArchivedDrawer.test.tsx / tools.test.ts convention).
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { ParamsSchemaEditor } from './ParamsSchemaEditor';
import { makeEmptyParamRow, type ParamFieldRow } from './scaffold';

function row(overrides: Partial<ParamFieldRow>): ParamFieldRow {
  return { ...makeEmptyParamRow(), ...overrides };
}

describe('ParamsSchemaEditor', () => {
  it('renders one row per param, with its name and type reflected', () => {
    render(
      <ParamsSchemaEditor
        rows={[
          row({ id: 'r1', name: 'query', type: 'string' }),
          row({ id: 'r2', name: 'count', type: 'number' }),
        ]}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByDisplayValue('query')).toBeInTheDocument();
    expect(screen.getByDisplayValue('count')).toBeInTheDocument();
  });

  it('renders an empty-state hint with no rows', () => {
    render(<ParamsSchemaEditor rows={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/no parameters yet/i)).toBeInTheDocument();
  });

  it('"Add parameter" appends a new empty row', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ParamsSchemaEditor rows={[row({ id: 'r1', name: 'query' })]} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /add parameter/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as ParamFieldRow[];
    expect(next).toHaveLength(2);
    expect(next[0].name).toBe('query');
    expect(next[1].name).toBe('');
  });

  it('editing a row name calls onChange with that row updated in place', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ParamsSchemaEditor rows={[row({ id: 'r1', name: '' })]} onChange={onChange} />);

    const nameInput = screen.getByLabelText(/parameter name/i);
    await user.type(nameInput, 'x');

    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as ParamFieldRow[];
    expect(last[0].name).toBe('x');
    expect(last[0].id).toBe('r1');
  });

  it("changing the type select updates that row's type", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ParamsSchemaEditor
        rows={[row({ id: 'r1', name: 'mode', type: 'string' })]}
        onChange={onChange}
      />
    );

    await user.selectOptions(screen.getByLabelText(/parameter type/i), 'enum');

    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as ParamFieldRow[];
    expect(last[0].type).toBe('enum');
  });

  it('reveals an enum-values input only when the row type is enum', () => {
    const { rerender } = render(
      <ParamsSchemaEditor rows={[row({ id: 'r1', type: 'string' })]} onChange={vi.fn()} />
    );
    expect(screen.queryByLabelText(/enum values/i)).not.toBeInTheDocument();

    rerender(<ParamsSchemaEditor rows={[row({ id: 'r1', type: 'enum' })]} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/enum values/i)).toBeInTheDocument();
  });

  it('editing enum values parses a comma-separated list into enumValues', () => {
    const onChange = vi.fn();
    render(
      <ParamsSchemaEditor
        rows={[row({ id: 'r1', type: 'enum', enumValues: [] })]}
        onChange={onChange}
      />
    );

    // A single change event with the full string — this is a controlled
    // input driven by the `rows` prop, which this bare mock never feeds
    // back, so simulating keystroke-by-keystroke (user.type) would have
    // each keystroke act on the same static, unchanged prop value instead
    // of accumulating.
    fireEvent.change(screen.getByLabelText(/enum values/i), { target: { value: 'a,b' } });

    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as ParamFieldRow[];
    expect(last[0].enumValues).toEqual(['a', 'b']);
  });

  it("toggling the required switch flips that row's required flag", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ParamsSchemaEditor rows={[row({ id: 'r1', required: false })]} onChange={onChange} />);

    await user.click(screen.getByRole('switch'));

    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as ParamFieldRow[];
    expect(last[0].required).toBe(true);
  });

  it('removing a row calls onChange with that row filtered out, others untouched', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ParamsSchemaEditor
        rows={[row({ id: 'r1', name: 'a' }), row({ id: 'r2', name: 'b' })]}
        onChange={onChange}
      />
    );

    const rows = screen.getAllByRole('group');
    await user.click(within(rows[0]).getByRole('button', { name: /remove/i }));

    const next = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as ParamFieldRow[];
    expect(next).toHaveLength(1);
    expect(next[0].name).toBe('b');
  });

  it('disables all row controls and the add button when disabled', () => {
    render(<ParamsSchemaEditor rows={[row({ id: 'r1' })]} onChange={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: /add parameter/i })).toBeDisabled();
    expect(screen.getByLabelText(/parameter name/i)).toBeDisabled();
  });
});
