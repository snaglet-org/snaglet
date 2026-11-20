/**
 * A rich editor loads the agent roster when it mounts, so a doc whose agent
 * references are all `[Name](agent-id)` links (no `@` to trigger a load)
 * still chips them. Its own file: the roster cache must start cold.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChipEditableInput } from './ChipEditableInput';

const api = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: api.list } };
});

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
  cleanup();
});

describe('ChipEditableInput agent roster load', () => {
  it('loads the roster once rich editors mount and chips their agent links', async () => {
    api.list.mockResolvedValue([{ id: 'test-agent-a', name: 'Test Agent A' }]);
    const props = {
      value: 'Ask [Test Agent A](test-agent-a) to review.',
      onChange: vi.fn(),
      richBlocks: true,
      multiline: true,
    };
    const first = render(<ChipEditableInput {...props} ariaLabel="First" />);

    await waitFor(() =>
      expect(first.container.querySelector('[data-node-kind="agent"]')).not.toBeNull()
    );
    expect(api.list).toHaveBeenCalledOnce();

    // A loaded roster is not fetched again by the next editor.
    const second = render(<ChipEditableInput {...props} ariaLabel="Second" />);
    await act(async () => Promise.resolve());
    expect(second.container.querySelector('[data-node-kind="agent"]')).not.toBeNull();
    expect(api.list).toHaveBeenCalledOnce();
  });
});
