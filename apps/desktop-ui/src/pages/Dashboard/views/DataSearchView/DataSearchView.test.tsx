import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataSearchView } from './DataSearchView';

vi.mock('./EmbeddingsMaintenanceView', () => ({
  EmbeddingsMaintenanceView: () => <div>Embedding maintenance body</div>,
}));
vi.mock('../DatabaseSettingsView', () => ({
  DatabaseSettingsView: () => <div>Database backups body</div>,
}));

describe('DataSearchView', () => {
  it('opens the embedding maintenance page for the restored tab and legacy default', () => {
    const { rerender } = render(<DataSearchView tab="embeddings" />);

    expect(screen.getByRole('heading', { name: 'Embeddings' })).toBeInTheDocument();
    expect(screen.getByText('Embedding maintenance body')).toBeInTheDocument();

    rerender(<DataSearchView />);
    expect(screen.getByText('Embedding maintenance body')).toBeInTheDocument();
  });

  it('keeps backups on its existing destination', () => {
    render(<DataSearchView tab="backups" />);

    expect(
      screen.getByRole('heading', { name: 'Backups of the local database' })
    ).toBeInTheDocument();
    expect(screen.getByText('Database backups body')).toBeInTheDocument();
  });
});
