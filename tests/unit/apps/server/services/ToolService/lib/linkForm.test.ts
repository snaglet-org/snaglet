/**
 * linkForm — canonical "ready to paste" markdown link string builder.
 *
 * Docs converted from tasks keep their `task-…` node ids, so a `task-…` id
 * takes the bare-id "already self-identifying" path (`[Title](task-…)`)
 * rather than getting a `doc:` scheme prefix.
 */

import { linkForm } from '@server/services/ToolService/lib/linkForm';

describe('linkForm', () => {
  it('emits the bare-id form for a task- prefixed id (converted task-doc)', () => {
    expect(linkForm('doc', 'task-1111111111111-hoznartwp', 'My Task')).toBe(
      '[My Task](task-1111111111111-hoznartwp)'
    );
  });

  it('still emits the bare-id form for a doc- prefixed id (unaffected baseline)', () => {
    expect(linkForm('doc', 'doc-1111111111111-hoznartwp', 'My Doc')).toBe(
      '[My Doc](doc-1111111111111-hoznartwp)'
    );
  });

  it('still emits the scheme-prefixed form for a legacy bare-UUID doc id', () => {
    expect(linkForm('doc', '9494d9d0-ae25-4509-a8f6-fb86ae2ba238', 'My Doc')).toBe(
      '[My Doc](doc:9494d9d0-ae25-4509-a8f6-fb86ae2ba238)'
    );
  });

  it('emits the bare-id form for a sketch- prefixed id, with a sketch fallback title', () => {
    expect(linkForm('sketch', 'sketch-1111111111111-hoznartwp', 'Login wireframe')).toBe(
      '[Login wireframe](sketch-1111111111111-hoznartwp)'
    );
    expect(linkForm('sketch', 'sketch-1111111111111-hoznartwp', null)).toBe(
      '[Untitled Sketch](sketch-1111111111111-hoznartwp)'
    );
  });

  it('falls back to the type default title for a task- prefixed id with no title', () => {
    expect(linkForm('doc', 'task-1111111111111-hoznartwp', null)).toBe(
      '[Untitled Doc](task-1111111111111-hoznartwp)'
    );
  });
});
