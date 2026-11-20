/**
 * Turning a doc chip into a transclusion in a doc body asks the server first:
 * one that would loop back to the doc is refused with a notice and the doc is
 * left unchanged; any other becomes a transclusion.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ loop: vi.fn(), get: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) },
    docsApi: { ...actual.docsApi, transclusionLoop: api.loop, get: api.get },
  };
});
vi.mock('@desktop/utils/toast', () => ({ showToast: toast }));

import { HostDocProvider } from '../lineLinks/hostDoc';
import { ChipEditableInput } from './ChipEditableInput';

const HOST = 'doc-1111111111111-aaaaaaaaa';
const OTHER = 'doc-2222222222222-bbbbbbbbb';

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
});

const chip = () => document.querySelector<HTMLElement>(`.md-chip[data-node-url="${OTHER}"]`);

async function mount() {
  const onChange = vi.fn();
  render(
    <HostDocProvider docId={HOST}>
      <ChipEditableInput
        value={`See [Other](${OTHER}) here`}
        onChange={onChange}
        allowInlineParse
        ariaLabel="Body"
        enableNodeMentions={false}
      />
    </HostDocProvider>
  );
  await screen.findByRole('textbox', { name: 'Body' });
  await waitFor(() => expect(chip()).not.toBeNull());
  return onChange;
}

describe('transcluding a doc into the doc being edited', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ id: OTHER, title: 'Other', content: 'other body' });
  });

  it('explains what a transclusion is on the toggle', async () => {
    await mount();
    const toggle = screen.getByRole('button', { name: 'Transclude a doc' });
    expect(toggle).toHaveAttribute(
      'title',
      "Transclude a doc: show another doc's content here, kept in sync."
    );
  });

  it('refuses one that would loop, with a notice, and changes nothing', async () => {
    api.loop.mockResolvedValue({
      loop: [
        { id: HOST, title: 'Plan' },
        { id: OTHER, title: 'Other' },
        { id: HOST, title: 'Plan' },
      ],
    });
    const onChange = await mount();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Transclude a doc' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Can\'t transclude "Other" here: it would make a loop (Plan → Other → Plan). Nothing was changed.',
        expect.anything()
      )
    );
    expect(api.loop).toHaveBeenCalledWith(HOST, OTHER);
    expect(chip()).toHaveAttribute('data-chip-include', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('transcludes one that does not loop', async () => {
    api.loop.mockResolvedValue({ loop: null });
    const onChange = await mount();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Transclude a doc' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const saved = String(onChange.mock.calls[onChange.mock.calls.length - 1]![0]);
    expect(saved).toContain(`![](${OTHER})`);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('the preview toggle after the loop check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ id: OTHER, title: 'Other', content: 'other body' });
  });

  it('applies to the text as it is when the check answers, not as it was', async () => {
    let resolveCheck: (value: { loop: null }) => void = () => {};
    api.loop.mockReturnValue(new Promise((resolve) => (resolveCheck = resolve)));
    const onChange = vi.fn();
    const props = {
      onChange,
      allowInlineParse: true,
      ariaLabel: 'Body',
      enableNodeMentions: false,
      allowMarkdownPreview: true,
      defaultMode: 'preview' as const,
    };
    const view = render(
      <HostDocProvider docId={HOST}>
        <ChipEditableInput value={`See [Other](${OTHER}) here`} {...props} />
      </HostDocProvider>
    );
    const toggle = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        '.md-chip-toggle[data-toggle-direction="include"]'
      );
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(toggle);
    // The person keeps typing while the server answers.
    view.rerender(
      <HostDocProvider docId={HOST}>
        <ChipEditableInput value={`See [Other](${OTHER}) here, and more`} {...props} />
      </HostDocProvider>
    );
    resolveCheck({ loop: null });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenLastCalledWith(`See ![](${OTHER}) here, and more`);
  });
});
