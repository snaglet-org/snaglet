/**
 * A chip's label is its own link text: editing it changes this chip in this
 * doc, never the name of the item it points to.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { ChipEditableInput } from './ChipEditableInput';

const DOC_ID = 'doc-1111111111111-aaaaaaaaa';
const VALUE = `See [Field guide](${DOC_ID}) here`;

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
});

const chip = () => document.querySelector<HTMLElement>(`.md-chip[data-node-url="${DOC_ID}"]`);
const labelInput = () => chip()!.querySelector<HTMLInputElement>('.md-chip-label-input');

async function mount(disabled = false) {
  const onChange = vi.fn();
  render(
    <ChipEditableInput
      value={VALUE}
      onChange={onChange}
      disabled={disabled}
      allowInlineParse
      ariaLabel="Notes"
      enableNodeMentions={false}
    />
  );
  await screen.findByRole('textbox', { name: 'Notes' });
  await waitFor(() => expect(chip()).not.toBeNull());
  return onChange;
}

async function startEditing() {
  fireEvent.mouseDown(chip()!.querySelector<HTMLElement>('.md-chip-rename')!);
  await waitFor(() => expect(labelInput()).not.toBeNull());
  return labelInput()!;
}

describe('editing a chip label', () => {
  it('saves the new label as the link text on Enter and keeps the target', async () => {
    const onChange = await mount();
    const input = await startEditing();
    expect(input.value).toBe('Field guide');
    fireEvent.change(input, { target: { value: '  the guide ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(labelInput()).toBeNull());
    expect(chip()!.querySelector('.md-chip-title')!.textContent).toBe('the guide');
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(`See [the guide](${DOC_ID}) here`)
    );
  });

  it('keeps the old label on Escape and on an empty label', async () => {
    const onChange = await mount();
    let input = await startEditing();
    fireEvent.change(input, { target: { value: 'something else' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(labelInput()).toBeNull());
    expect(chip()!.querySelector('.md-chip-title')!.textContent).toBe('Field guide');

    input = await startEditing();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(labelInput()).toBeNull());
    expect(chip()!.querySelector('.md-chip-title')!.textContent).toBe('Field guide');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('offers no label editing in a read-only editor', async () => {
    await mount(true);
    expect(chip()!.querySelector('.md-chip-rename')).toBeNull();
  });
});
