/**
 * Which panes may carry an Export action.
 *
 * Doc, thread and image panes only. Containers are excluded because a
 * recursive tree export is a different feature, and files because they are
 * already on disk.
 *
 * This is a structural test: it reads the view sources rather than rendering
 * them, to catch an edit that wires the button into another pane without
 * mounting most of the workspace tree. It fails loudly if a file moves.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const VIEWS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../pages/Dashboard/views'
);

const MOUNTS_EXPORT = [
  'DocView/DocView.tsx',
  'ChatView/ChatView.tsx',
  'ImageView/ImageView.tsx',
] as const;

const MUST_NOT_MOUNT_EXPORT = [
  'ContainerView/ContainerView.tsx',
  'FileView/FileView.tsx',
  'AgentView/AgentView.tsx',
] as const;

function source(relative: string): string {
  // Throws with the missing path if a view is renamed, which is the signal to
  // revisit this list rather than silently lose coverage.
  return readFileSync(path.join(VIEWS, relative), 'utf8');
}

describe('panes that export', () => {
  it.each(MOUNTS_EXPORT)('%s mounts ExportButton in the pane chrome', (relative) => {
    const text = source(relative);
    expect(text).toContain('ExportButton');
    // Directly, or through PropertiesPanel's topbarActions (which registers
    // them into the pane chrome beside the Properties toggle).
    expect(text).toMatch(/usePaneChromeActions|topbarActions=\{/);
  });

  it.each(MOUNTS_EXPORT)('%s exports the kind matching its own pane', (relative) => {
    const text = source(relative);
    const expected = relative.startsWith('DocView')
      ? 'kind="doc"'
      : relative.startsWith('ChatView')
        ? 'kind="thread"'
        : 'kind="image"';
    expect(text).toContain(expected);
  });
});

describe('panes that must not export', () => {
  it.each(MUST_NOT_MOUNT_EXPORT)('%s carries no export action', (relative) => {
    expect(source(relative)).not.toContain('ExportButton');
  });

  it('no view claims a container or file export kind', () => {
    for (const relative of [...MOUNTS_EXPORT, ...MUST_NOT_MOUNT_EXPORT]) {
      const text = source(relative);
      expect(text).not.toContain('kind="container"');
      expect(text).not.toContain('kind="file"');
    }
  });
});
