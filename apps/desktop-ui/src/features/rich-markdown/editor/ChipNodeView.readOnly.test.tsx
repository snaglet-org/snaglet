/**
 * Chips in a read-only editor (a disabled field, a version preview) render as
 * usual but offer nothing that changes the document: no remove, no include
 * toggle.
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

function Input({ disabled, onChange }: { disabled: boolean; onChange: (next: string) => void }) {
  return (
    <ChipEditableInput
      value={VALUE}
      onChange={onChange}
      disabled={disabled}
      allowInlineParse
      ariaLabel="Notes"
      enableNodeMentions={false}
    />
  );
}

async function mount(disabled: boolean) {
  const onChange = vi.fn();
  const view = render(<Input disabled={disabled} onChange={onChange} />);
  await screen.findByRole('textbox', { name: 'Notes' });
  await waitFor(() => expect(chip()).not.toBeNull());
  return {
    onChange,
    rerender: (next: boolean) => view.rerender(<Input disabled={next} onChange={onChange} />),
  };
}

describe('chips in a read-only editor', () => {
  it('offers remove and include toggle while editable', async () => {
    await mount(false);
    expect(chip()!.querySelector('.md-chip-remove')).not.toBeNull();
    expect(chip()!.querySelector('.md-chip-toggle')).not.toBeNull();
  });

  it('offers neither while disabled, keeping copy', async () => {
    await mount(true);
    expect(chip()!.querySelector('.md-chip-remove')).toBeNull();
    expect(chip()!.querySelector('.md-chip-toggle')).toBeNull();
    // Copying a reference does not change the document, so it stays.
    expect(chip()!.querySelector('.md-chip-copy')).not.toBeNull();
  });

  it('never removes or expands a chip once the editor turns read-only', async () => {
    const { onChange, rerender } = await mount(false);
    const remove = chip()!.querySelector<HTMLElement>('.md-chip-remove')!;
    const toggle = chip()!.querySelector<HTMLElement>('.md-chip-toggle')!;
    rerender(true);
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveAttribute(
      'contenteditable',
      'false'
    );

    // Even a control still on screen from the editable render is inert.
    fireEvent.mouseDown(toggle);
    fireEvent.mouseDown(remove);
    expect(chip()).not.toBeNull();
    expect(chip()).toHaveAttribute('data-chip-include', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });
});
