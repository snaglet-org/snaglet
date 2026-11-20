import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TABLE_ENTRY_PAGE_SIZES } from '@snaglet/shared/types';
import { TablePagination } from './TablePagination';
import styles from './TablePagination.module.scss';

function setup(overrides: Partial<Parameters<typeof TablePagination>[0]> = {}) {
  const props = {
    page: 1,
    pageSize: 25,
    totalCount: 12,
    onPageChange: vi.fn(),
    onPageSizeChange: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<TablePagination {...props} />) };
}

describe('TablePagination', () => {
  it.each([
    [0, '0 rows'],
    [1, '1 row'],
    [12, '12 rows'],
    [25, '25 rows'],
  ] as const)(
    'shows a plain count for %i rows without redundant page controls',
    (totalCount, label) => {
      setup({ totalCount });
      expect(screen.getByRole('status')).toHaveTextContent(label);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument();
      if (totalCount > Math.min(...TABLE_ENTRY_PAGE_SIZES))
        expect(screen.getByRole('combobox', { name: 'Rows per page' })).toHaveValue('25');
      else expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    }
  );

  it('counts search matches instead of rows while filtered', () => {
    const { rerender, props } = setup({ totalCount: 1, filtered: true });
    expect(screen.getByRole('status')).toHaveTextContent('1 matching');
    rerender(<TablePagination {...props} totalCount={80} page={2} filtered />);
    expect(screen.getByRole('status')).toHaveTextContent('26–50 of 80 matching');
    // Narrow panes hide that range; this compact count stands in for it.
    expect(document.querySelector(`.${styles.compactCount}`)).toHaveTextContent('80 matching');
  });

  it('only offers page sizing once the row count exceeds the smallest supported page', () => {
    const smallest = Math.min(...TABLE_ENTRY_PAGE_SIZES);
    const { props, rerender } = setup({ totalCount: smallest, pageSize: 100 });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText('/ page')).not.toBeInTheDocument();

    rerender(<TablePagination {...props} totalCount={smallest + 1} />);
    expect(screen.getByRole('combobox', { name: 'Rows per page' })).toHaveValue('100');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('uses a native inline page-size select without the themed caret shell', async () => {
    const { props } = setup();
    const select = screen.getByRole('combobox', { name: 'Rows per page' });
    expect(select).toHaveClass(styles.select);
    expect(select.parentElement?.tagName).toBe('LABEL');
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(
      TABLE_ENTRY_PAGE_SIZES.map(String)
    );
    await userEvent.tab();
    expect(select).toHaveFocus();
    await userEvent.selectOptions(select, '50');
    expect(props.onPageSizeChange).toHaveBeenCalledWith(50);
    expect(props.onPageChange).not.toHaveBeenCalled();
  });

  it('shows a useful range and enables keyboard page navigation only within bounds', async () => {
    const { props, rerender } = setup({ totalCount: 64 });
    expect(screen.getByRole('status', { name: 'Page 1 of 3' })).toHaveTextContent('1–25 of 64');
    expect(screen.getByRole('button', { name: 'First page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    const next = screen.getByRole('button', { name: 'Next page' });
    next.focus();
    await userEvent.keyboard('{Enter}');
    expect(props.onPageChange).toHaveBeenLastCalledWith(2);
    const last = screen.getByRole('button', { name: 'Last page' });
    last.focus();
    await userEvent.keyboard(' ');
    expect(props.onPageChange).toHaveBeenLastCalledWith(3);

    rerender(<TablePagination {...props} page={3} />);
    expect(screen.getByRole('status', { name: 'Page 3 of 3' })).toHaveTextContent('51–64 of 64');
    expect(next).toBeDisabled();
    expect(last).toBeDisabled();
    screen.getByRole('button', { name: 'Previous page' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(props.onPageChange).toHaveBeenLastCalledWith(2);
    await userEvent.click(screen.getByRole('button', { name: 'First page' }));
    expect(props.onPageChange).toHaveBeenLastCalledWith(1);
  });

  it('carries a compact position between previous and next for narrow panes', () => {
    const { container, rerender, props } = setup({ page: 3, totalCount: 300 });
    const compact = container.querySelector(`.${styles.compactPage}`);
    expect(compact).toHaveTextContent('3 / 12');
    expect(compact?.previousElementSibling).toHaveAccessibleName('Previous page');
    expect(compact?.nextElementSibling).toHaveAccessibleName('Next page');
    expect(screen.getByRole('group')).toHaveClass(styles.paged);
    for (const name of ['First page', 'Last page'])
      expect(screen.getByRole('button', { name })).toHaveClass(styles.edgeButton);
    expect(screen.getByRole('button', { name: 'Next page' })).not.toHaveClass(styles.edgeButton);

    rerender(<TablePagination {...props} totalCount={12} />);
    expect(container.querySelector(`.${styles.compactPage}`)).toBeNull();
    expect(screen.getByRole('group')).not.toHaveClass(styles.paged);
  });

  it('keeps a disappearing last page in bounds while the parent refreshes', async () => {
    const { props } = setup({ page: 4, totalCount: 60 });
    expect(screen.getByRole('status', { name: 'Page 3 of 3' })).toHaveTextContent('51–60 of 60');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(props.onPageChange).toHaveBeenCalledWith(2);
  });

  it('disables all mutations while loading or saving', async () => {
    const { props } = setup({ page: 2, totalCount: 64, disabled: true });
    expect(screen.getByRole('combobox', { name: 'Rows per page' })).toBeDisabled();
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
      await userEvent.click(button);
    }
    expect(props.onPageChange).not.toHaveBeenCalled();
    expect(props.onPageSizeChange).not.toHaveBeenCalled();
  });

  it('supports read-only page sizing without leaving an empty control', () => {
    setup({ onPageSizeChange: undefined });
    expect(screen.getByRole('status')).toHaveTextContent('12 rows');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText('/ page')).not.toBeInTheDocument();
  });
});
