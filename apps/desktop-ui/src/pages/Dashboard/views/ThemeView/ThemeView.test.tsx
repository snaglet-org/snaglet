/**
 * ThemeView — the client display preferences surfaced in Settings → Theme.
 * The color pickers have their own coverage (colorTokens.test.ts); these
 * tests pin which sections the Settings surface shows and that each color
 * says what it paints.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { workspaceColorTokens } from '@snaglet/shared/constants/workspaceTheme';
import { DEFAULT_THEME_NAME, defaultTheme } from '@snaglet/theme';

import { ThemeView } from './ThemeView';

describe('ThemeView — sections', () => {
  it('renders the agent popups and three color sections', () => {
    const { container } = render(<ThemeView />);
    expect(container.querySelectorAll('section')).toHaveLength(4);
    expect(screen.getByRole('heading', { name: 'Agent popups' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Base palette' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Chat display' })).not.toBeInTheDocument();
  });

  it('offers the Doc color with the other node kinds', () => {
    render(<ThemeView />);
    const heading = screen.getByRole('heading', {
      name: 'Docs, threads, agents, tools, memories, images',
    });
    const section = heading.closest('section')!;
    expect(within(section).getByLabelText('Doc color')).toHaveValue(defaultTheme['color-node-doc']);
    expect(within(section).getByLabelText('Thread color')).toBeInTheDocument();
  });

  it('names the default theme and offers a reset back to it', () => {
    render(<ThemeView />);
    expect(DEFAULT_THEME_NAME).toBe('Soft Pastel Garden');
    expect(screen.getByRole('button', { name: 'Reset to Soft Pastel Garden' })).toBeInTheDocument();
    expect(screen.getByText(/The default theme is Soft Pastel Garden\./)).toBeInTheDocument();
  });

  it('describes what every color paints under its label', () => {
    render(<ThemeView />);
    for (const token of workspaceColorTokens) {
      expect(screen.getByLabelText(`${token.label} color`)).toHaveAccessibleDescription(
        token.description
      );
    }
    expect(screen.getByLabelText('Activity Bar color')).toHaveAccessibleDescription(
      /narrow strip of icons on the far left/
    );
  });

  it('has no global Text size control (chat text size is set per thread)', () => {
    render(<ThemeView />);
    expect(screen.queryByRole('heading', { name: 'Text size' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });
});
