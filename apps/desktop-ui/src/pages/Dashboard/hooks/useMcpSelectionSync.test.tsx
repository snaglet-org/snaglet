import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { emitMcpConnectionEvent } from '@desktop/utils/mcpConnectionEvents';
import { createLeaf, type LayoutNode } from '../layout/paneTree';
import { useMcpSelectionSync } from './useMcpSelectionSync';

describe('useMcpSelectionSync', () => {
  it('updates the current pane and history after a client rename', () => {
    const initial = createLeaf({
      kind: 'mcp-client-connection',
      client_id: 'client-1',
      name: 'Before',
    });
    const { result } = renderHook(() => {
      const [layout, setLayout] = useState<LayoutNode>(initial);
      useMcpSelectionSync(setLayout);
      return layout;
    });

    act(() => {
      emitMcpConnectionEvent({ type: 'client-renamed', id: 'client-1', name: 'After' });
    });

    expect(result.current).toMatchObject({
      kind: 'leaf',
      selection: { kind: 'mcp-client-connection', name: 'After' },
      history: {
        entries: [{ kind: 'mcp-client-connection', name: 'After' }],
      },
    });
  });
});
