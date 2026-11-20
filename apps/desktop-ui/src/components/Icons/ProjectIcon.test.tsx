/**
 * ProjectIcon — the container box with a floating star. The star's gap is an
 * SVG mask, so every icon on screen needs its own mask id, and the box group
 * must point at that icon's own mask.
 */
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { iconFor } from '@desktop/pages/Dashboard/views/ContainerView/helpers';
import type { ContainerTreeNode } from '@desktop/utils/api';
import { ProjectIcon } from './ProjectIcon';

it('gives each icon its own mask and points the box at it', () => {
  const { container } = render(
    <>
      <ProjectIcon />
      <ProjectIcon />
    </>
  );
  const masks = [...container.querySelectorAll('mask')].map((mask) => mask.id);
  expect(masks).toHaveLength(2);
  expect(new Set(masks).size).toBe(2);
  for (const id of masks) {
    expect(id).toMatch(/^[\w-]+$/);
    expect(container.querySelector(`g[mask="url(#${id})"]`)).not.toBeNull();
  }
});

it('is the icon a project container gets in a container pane', () => {
  const folder: ContainerTreeNode = {
    kind: 'container',
    id: 'container-1111111111111-aaaaaaaaa',
    name: 'Folder',
    category: null,
    parentId: null,
    folderPath: null,
    githubUrl: null,
    children: [],
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const project = render(<>{iconFor({ ...folder, category: 'project' })}</>).container;
  const plain = render(<>{iconFor(folder)}</>).container;
  expect(project.querySelector('mask')).not.toBeNull();
  expect(plain.querySelector('mask')).toBeNull();
});
