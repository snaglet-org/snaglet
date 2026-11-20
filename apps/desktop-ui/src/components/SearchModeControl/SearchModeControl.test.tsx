import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SearchModeControl } from './SearchModeControl';

describe('SearchModeControl', () => {
  it('reports a per-query channel change', async () => {
    const onChange = vi.fn();
    render(
      <SearchModeControl
        value={{ keyword: true, vector: true }}
        onChange={onChange}
        context="test"
      />
    );

    await userEvent.click(screen.getByRole('checkbox', { name: 'Vector' }));
    expect(onChange).toHaveBeenCalledWith({ keyword: true, vector: false });
  });

  it('keeps the only active channel enabled', () => {
    render(
      <SearchModeControl
        value={{ keyword: true, vector: false }}
        onChange={vi.fn()}
        context="test"
      />
    );

    expect(screen.getByRole('checkbox', { name: 'Keyword' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Vector' })).not.toBeDisabled();
  });

  it('offers only Keyword and Vector', () => {
    render(
      <SearchModeControl
        value={{ keyword: true, vector: true }}
        onChange={vi.fn()}
        context="test"
      />
    );

    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByRole('checkbox', { name: 'Keyword' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Vector' })).toBeInTheDocument();
  });
});
