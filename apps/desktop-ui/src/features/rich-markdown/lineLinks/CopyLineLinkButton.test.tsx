import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/features/rich-markdown/editor', () => ({
  ChipEditableInput: () => <div data-testid="mock-rich-editor" />,
}));

import { WorkspaceEditor } from '../workspace-editor/WorkspaceEditor';
import { headingLinkMarkdown, lineLinkMarkdown } from './CopyLineLinkButton';

const DOC = 'doc-1111111111111-aaaaaaaaa';
const MD = '# Scraping\n\nFirecrawl handles the crawl\nand returns markdown.';

describe('copy line link', () => {
  it('formats a heading chip with the heading text', () => {
    expect(
      headingLinkMarkdown(DOC, 'Penny', 'Rate limits', {
        heading: { slug: 'rate-limits', level: 3 },
      })
    ).toBe(`[Penny › Rate limits](${DOC}#h3=rate-limits)`);
  });

  it('formats a chip with the title and line label', () => {
    expect(lineLinkMarkdown(DOC, 'Penny', { startLine: 3, endLine: 4 })).toBe(
      `[Penny › L3–4](${DOC}#L3-L4)`
    );
  });

  it('selecting text in source mode floats a button that copies its line link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <WorkspaceEditor
        kind="doc-body"
        savedValue={MD}
        onSave={vi.fn()}
        sourceMode
        lineLinks={{ docId: DOC, docTitle: 'Penny' }}
      />
    );
    const ta = screen.getByTestId('workspace-editor-source-textarea') as HTMLTextAreaElement;
    expect(screen.queryByTestId('copy-line-link')).toBeNull();

    const start = MD.indexOf('handles');
    act(() => {
      ta.focus();
      ta.setSelectionRange(start, start + 'handles the crawl'.length);
    });
    fireEvent.keyUp(ta, { key: 'Shift' });

    const button = await screen.findByTestId('copy-line-link');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith(`[Penny › L3:11–3:27](${DOC}#L3:11-L3:27)`);
  });

  it('no button without line links (non-doc editors)', () => {
    render(<WorkspaceEditor kind="doc-body" savedValue={MD} onSave={vi.fn()} sourceMode />);
    const ta = screen.getByTestId('workspace-editor-source-textarea') as HTMLTextAreaElement;
    act(() => {
      ta.focus();
      ta.setSelectionRange(0, 5);
    });
    fireEvent.keyUp(ta, { key: 'Shift' });
    expect(screen.queryByTestId('copy-line-link')).toBeNull();
  });
});
