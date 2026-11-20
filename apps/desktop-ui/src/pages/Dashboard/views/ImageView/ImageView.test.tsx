import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/hooks/useAuthenticatedImage', () => ({
  useAuthenticatedImage: (imageId: string | null | undefined) => {
    if (!imageId) return { blobUrl: null, loading: false, error: null };
    return {
      blobUrl: `/api/images/${imageId}/content`,
      loading: false,
      error: null,
    };
  },
}));

vi.mock('@desktop/features/rich-markdown/editor/index.js', () => ({
  ChipEditableInput: ({
    value,
    onChange,
    onSubmit,
    placeholder,
    ariaLabel,
  }: {
    value: string;
    onChange: (next: string) => void;
    onSubmit?: () => void;
    placeholder?: string;
    ariaLabel?: string;
  }) => (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSubmit?.();
      }}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  ),
}));

import type { ImageTreeNode } from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { ImageView } from './ImageView';

const imageNode: ImageTreeNode = {
  kind: 'image',
  id: 'image-1111111111111-mkzahe3ag',
  containerId: null,
  name: 'preview.png',
  description: null,
  tags: [],
  mimeType: 'image/png',
  sizeBytes: 2048,
  sortOrder: 0,
  url: '/api/images/image-1111111111111-mkzahe3ag/content',
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
};

describe('ImageView', () => {
  beforeEach(() => {
    // Properties disclosure persists to localStorage; reset so each test
    // starts from the collapsed default rather than inheriting a prior toggle.
    window.localStorage.clear();
  });

  it('renders the selected image as the pane content', () => {
    render(<ImageView node={imageNode} />);

    expect(screen.queryByRole('heading', { name: 'preview.png' })).not.toBeInTheDocument();
    expect(screen.queryByText('preview.png')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'preview.png' })).toHaveAttribute(
      'src',
      '/api/images/image-1111111111111-mkzahe3ag/content'
    );
    expect(screen.getByRole('button', { name: 'Preview image/png' })).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
  });

  it('shows the pane image in the pan/zoom viewer', () => {
    render(<ImageView node={imageNode} />);
    const viewer = screen.getByRole('group', { name: 'Image viewer' });
    expect(viewer).toContainElement(screen.getByRole('img', { name: 'preview.png' }));
  });

  it('opens the fullscreen preview in its own viewer, closed by a click beside the image', () => {
    render(<ImageView node={imageNode} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview image/png' }));

    const dialog = screen.getByRole('dialog', { name: 'preview.png preview' });
    const viewer = within(dialog).getByRole('group', { name: 'Image viewer' });
    expect(viewer).toHaveFocus();

    fireEvent.click(within(dialog).getByRole('img', { name: 'preview.png' }));
    expect(screen.getByRole('dialog', { name: 'preview.png preview' })).toBeInTheDocument();

    fireEvent.click(viewer);
    expect(screen.queryByRole('dialog', { name: 'preview.png preview' })).not.toBeInTheDocument();
  });

  it('closes the fullscreen preview from its corner button, the one close a zoomed image never covers', () => {
    render(<ImageView node={imageNode} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview image/png' }));

    const dialog = screen.getByRole('dialog', { name: 'preview.png preview' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog', { name: 'preview.png preview' })).not.toBeInTheDocument();
  });

  it('offers no auto-generation controls — metadata is entered by hand', () => {
    render(<ImageView node={imageNode} />);

    fireEvent.click(screen.getByTestId('properties-toggle'));

    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument();
    // The manual entry points are what remain.
    expect(screen.getByRole('textbox', { name: 'Image description' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Add image tag' })).toBeInTheDocument();
  });

  it('keeps type, size and Export in the toolbar, not in a Properties bar', () => {
    render(<ImageView node={imageNode} />);
    const strip = screen.getByTestId('properties-strip');
    expect(within(strip).getByText('2 KB')).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Preview image/png' })).toBeInTheDocument();
    expect(within(strip).getByTestId('properties-toggle')).toBeInTheDocument();
  });

  it('updates visible metadata when another client or an agent saves it', () => {
    render(
      <ImageView node={{ ...imageNode, description: 'Old description', tags: ['old-tag'] }} />
    );

    fireEvent.click(screen.getByTestId('properties-toggle'));

    act(() => {
      emitLibraryEvent({
        type: 'image-metadata-saved',
        id: imageNode.id,
        description: 'New searchable description',
        tags: ['new-tag'],
        updatedAt: '2026-07-20T00:00:00.000Z',
      });
    });

    expect(screen.getByDisplayValue('New searchable description')).toBeInTheDocument();
    expect(screen.getByText('new-tag')).toBeInTheDocument();
    expect(screen.queryByText('Old description')).not.toBeInTheDocument();
    expect(screen.queryByText('old-tag')).not.toBeInTheDocument();
  });

  it('exposes description and tags in the pull-out Properties panel', () => {
    render(
      <ImageView node={{ ...imageNode, description: 'A useful reference', tags: ['reference'] }} />
    );
    const properties = screen.getByTestId('properties-toggle');
    expect(properties).toHaveAttribute('aria-expanded', 'false');
    // Collapsed by default: metadata is not mounted until the panel is opened.
    expect(screen.queryByDisplayValue('A useful reference')).not.toBeInTheDocument();
    fireEvent.click(properties);
    expect(screen.getByDisplayValue('A useful reference')).toBeInTheDocument();
    expect(screen.getByText('reference')).toBeInTheDocument();
    fireEvent.click(properties);
    expect(screen.queryByDisplayValue('A useful reference')).not.toBeInTheDocument();
  });
});
