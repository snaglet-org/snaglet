import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// MarkdownRenderer's import chain (Chip → WikiLinkPreviewModal → api barrel)
// reads the client config at import time, which throws without a runtime
// env. Stub the vars before the graph evaluates.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { MarkdownToggleView } from './MarkdownToggleView';

/**
 * MarkdownToggleView is the toggle wired into the thread-summary / memory
 * bodies of WikiLinkPreviewModal, so this pins the preview-modal toggle
 * behavior: rendered view by default, raw markdown source on toggle.
 */
describe('MarkdownToggleView (preview-modal toggle)', () => {
  const SOURCE = '# Heading\n\nText with `code` and [a link](https://example.com).';

  it('renders markdown by default (no raw <pre>)', () => {
    render(<MarkdownToggleView content={SOURCE} />);
    // Rendered mode: the heading becomes a real element, not literal `#`.
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(document.querySelector('pre')).toBeNull();
  });

  it('reveals the exact raw source when toggled to md', async () => {
    const user = userEvent.setup();
    render(<MarkdownToggleView content={SOURCE} />);

    // Accessible name is the toggle's text ("rendered / md"); there's only
    // the one button on this plain-markdown surface.
    await user.click(screen.getByRole('button'));

    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    // Verbatim source — the whole point of the raw view.
    expect(pre?.textContent).toBe(SOURCE);
    expect(screen.queryByRole('heading', { name: 'Heading' })).not.toBeInTheDocument();
  });

  it('toggles back to rendered', async () => {
    const user = userEvent.setup();
    render(<MarkdownToggleView content={SOURCE} />);
    const button = screen.getByRole('button');

    await user.click(button); // → raw
    await user.click(button); // → rendered

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(document.querySelector('pre')).toBeNull();
  });

  it('hides the toggle when hideToggle is set', () => {
    render(<MarkdownToggleView content={SOURCE} hideToggle />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
