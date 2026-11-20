import type { ContainerCategory } from '@snaglet/shared/constants';

/**
 * Human-readable marker for a categorized container in agent-facing output.
 * Keep project stable: agents already recognize and rely on this exact tag.
 */
export function containerCategoryMarker(
  category: ContainerCategory | null | undefined
): string | null {
  switch (category) {
    case 'project':
      return '🗂️ project';
    default:
      return null;
  }
}
