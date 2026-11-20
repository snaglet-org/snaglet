import { normalizeToolParams } from '@server/services/ToolService/lib/normalizeToolParams';

describe('normalizeToolParams', () => {
  it('returns the input unchanged when there are no param_aliases', () => {
    const input = { doc_id: 'doc-1' };
    expect(normalizeToolParams(input, undefined)).toBe(input);
  });

  it('returns the input unchanged when param_aliases is an empty object', () => {
    const input = { doc_id: 'doc-1' };
    expect(normalizeToolParams(input, {})).toBe(input);
  });

  it('maps the canonical `id` onto the internal key the handler reads', () => {
    const result = normalizeToolParams({ id: 'doc-1' }, { doc_id: ['id'] });
    expect(result).toEqual({ id: 'doc-1', doc_id: 'doc-1' });
  });

  it('still accepts every legacy name directly — the internal key wins untouched', () => {
    const result = normalizeToolParams({ doc_id: 'doc-legacy' }, { doc_id: ['id'] });
    expect(result).toEqual({ doc_id: 'doc-legacy' });
  });

  it('prefers the internal key over the alias when both are present (never overwrites an explicit value)', () => {
    const result = normalizeToolParams(
      { id: 'doc-new', doc_id: 'doc-explicit' },
      { doc_id: ['id'] }
    );
    expect(result.doc_id).toBe('doc-explicit');
  });

  it('lets a canonical boolean win over its alias even when the canonical value is false', () => {
    const result = normalizeToolParams(
      { include_archived: false, with_archived: true },
      { include_archived: ['with_archived'] }
    );
    expect(result.include_archived).toBe(false);
  });

  it('walks multiple aliases in order and takes the first one present', () => {
    // A two-alias internal key `project_id` accepts `id` first, then a
    // `container_id` fallback — illustrative of the multi-alias resolution order.
    const viaId = normalizeToolParams({ id: 'c-1' }, { project_id: ['id', 'container_id'] });
    expect(viaId.project_id).toBe('c-1');

    const viaContainerId = normalizeToolParams(
      { container_id: 'c-2' },
      { project_id: ['id', 'container_id'] }
    );
    expect(viaContainerId.project_id).toBe('c-2');
  });

  it('leaves unrelated params untouched and does not invent keys for missing aliases', () => {
    const result = normalizeToolParams(
      { expand: true, doc_path: '/Snaglet/plan' },
      { doc_id: ['id'] }
    );
    expect(result).toEqual({ expand: true, doc_path: '/Snaglet/plan' });
    expect('id' in result).toBe(false);
    expect('doc_id' in result).toBe(false);
  });

  it('normalizes independently across multiple internal keys on the same tool', () => {
    // workspace_restore_node: `node_id` aliases `id`; the destination
    // `container_id` is a distinct, unaliased secondary param and must be
    // left exactly as the caller sent it.
    const result = normalizeToolParams(
      { id: 'node-1', container_id: 'container-2' },
      { node_id: ['id'] }
    );
    expect(result).toEqual({ id: 'node-1', container_id: 'container-2', node_id: 'node-1' });
  });

  it('does not mutate the original input object (copy-on-write)', () => {
    const input = { id: 'doc-1' };
    const result = normalizeToolParams(input, { doc_id: ['id'] });
    expect(result).not.toBe(input);
    expect(input).toEqual({ id: 'doc-1' });
  });

  it('is a no-op passthrough (same reference) when no alias actually applies', () => {
    const input = { doc_id: 'doc-1' };
    const result = normalizeToolParams(input, { doc_id: ['id'] });
    expect(result).toBe(input);
  });
});
