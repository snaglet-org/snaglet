const mockRequest = jest.fn();
const mockResolve = jest.fn();
jest.mock('@server/realtime/surfaces/ui', () => ({
  requestSidebar: (...args: unknown[]) => mockRequest(...args),
  resolveAnyConnectedUserId: () => mockResolve(),
}));
import tool from '@server/services/ToolService/tools/workspace/sidebar/tool';
beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockReturnValue('test-user');
  mockRequest.mockResolvedValue({ success: true, state: { open: false, active_tab: 'library' } });
});
test.each([
  { op: 'toggle' },
  { op: 'close', tab: 'tools' },
  { op: 'status', tab: 'tools' },
  { op: 'open', tab: 'workspace' },
  { op: 'open', extra: true },
  {},
])('rejects invalid input %j before UI traffic', async (input) => {
  await expect(tool(input, {})).rejects.toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test.each(['open', 'close', 'status'])('%s returns confirmed state', async (op) => {
  expect(JSON.parse((await tool({ op }, {})) as string)).toEqual({
    success: true,
    open: false,
    active_tab: 'library',
  });
});
test('no client is explicit failure', async () => {
  mockResolve.mockReturnValue(null);
  expect(JSON.parse((await tool({ op: 'status' }, {})) as string)).toEqual({
    success: false,
    reason: 'no_active_client',
  });
});
test('timeout is not a fabricated state', async () => {
  mockRequest.mockResolvedValue({ success: false, reason: 'sidebar_timeout' });
  expect(JSON.parse((await tool({ op: 'open', tab: 'tools' }, {})) as string)).toEqual({
    success: false,
    reason: 'sidebar_timeout',
  });
});

test('inspect passes read-only request and returns detail without reshaping', async () => {
  const state = {
    open: true,
    active_tab: 'agents',
    detail: {
      kind: 'list',
      items: [],
      selected_ids: [],
      search: { query: '', filters: [] },
      truncated: false,
      total_rendered: 0,
      state: 'ready',
      visibility: 'mounted',
    },
  };
  mockRequest.mockResolvedValue({ success: true, state });
  expect(JSON.parse((await tool({ op: 'inspect' }, {})) as string)).toEqual({
    success: true,
    ...state,
  });
  expect(mockRequest.mock.calls[0][0].command).toEqual({ op: 'inspect' });
});
test('inspect refuses tab instead of changing active view', async () => {
  await expect(tool({ op: 'inspect', tab: 'agents' }, {})).rejects.toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});

test.each(['expand', 'collapse'])(
  '%s validates and passes target only for disclosure',
  async (op) => {
    await expect(tool({ op }, {})).rejects.toThrow();
    await expect(tool({ op, target: '   ' }, {})).rejects.toThrow();
    await expect(
      tool({ op, target: '["library","container","container-1"]', tab: 'library' }, {})
    ).rejects.toThrow();
    mockRequest.mockResolvedValue({
      success: true,
      state: {
        open: true,
        active_tab: 'library',
        target: '["library","container","container-1"]',
        expanded: op === 'expand',
      },
    });
    expect(
      JSON.parse(
        (await tool({ op, target: '["library","container","container-1"]' }, {})) as string
      )
    ).toMatchObject({
      success: true,
      target: '["library","container","container-1"]',
      expanded: op === 'expand',
    });
    expect(mockRequest.mock.calls[0][0].command).toEqual({
      op,
      target: '["library","container","container-1"]',
    });
  }
);
test('target is refused on read operations', async () => {
  await expect(
    tool({ op: 'inspect', target: '["library","container","container-1"]' }, {})
  ).rejects.toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});

test.each([NaN, Infinity, -Infinity, '320', null])(
  'resize rejects invalid width %p before transport',
  async (width_px) => {
    await expect(tool({ op: 'resize', width_px }, {})).rejects.toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
  }
);
test('resize passes finite width for native clamping and refuses width on other operations', async () => {
  await expect(tool({ op: 'status', width_px: 320 }, {})).rejects.toThrow();
  mockRequest.mockResolvedValue({
    success: true,
    state: { open: false, active_tab: 'skills', width_px: 560 },
  });
  expect(JSON.parse((await tool({ op: 'resize', width_px: 999 }, {})) as string)).toMatchObject({
    success: true,
    width_px: 560,
    open: false,
  });
  expect(mockRequest.mock.calls[0][0].command).toEqual({ op: 'resize', width_px: 999 });
});

test.each([
  { op: 'scroll' },
  { op: 'scroll', to: 'bottom', target: '["providers","mounted","1"]' },
  { op: 'scroll', to: 'middle' },
  { op: 'scroll', target: 'not-a-handle' },
  { op: 'scroll', to: 'bottom', duration_ms: NaN },
  { op: 'scroll', to: 'bottom', duration_ms: '600' },
  { op: 'status', to: 'bottom' },
  { op: 'status', duration_ms: 600 },
])('scroll rejects invalid input %j before transport', async (input) => {
  await expect(tool(input, {})).rejects.toThrow('Nothing was changed');
  expect(mockRequest).not.toHaveBeenCalled();
});
test.each([
  [undefined, 600],
  [-50, 0],
  [6000, 6000],
  [99_999, 10_000],
])('scroll duration %p is sent clamped as %p', async (duration_ms, expected) => {
  mockRequest.mockResolvedValue({
    success: true,
    state: {
      open: true,
      active_tab: 'providers',
      scrolled: true,
      scroll_top: 400,
      scroll_height: 900,
      client_height: 500,
      at_bottom: true,
    },
  });
  const result = JSON.parse(
    (await tool(
      { op: 'scroll', to: 'bottom', ...(duration_ms !== undefined ? { duration_ms } : {}) },
      {}
    )) as string
  );
  expect(result).toMatchObject({ success: true, scrolled: true, at_bottom: true, scroll_top: 400 });
  expect(mockRequest.mock.calls[0][0].command).toEqual({
    op: 'scroll',
    to: 'bottom',
    duration_ms: expected,
  });
  expect(mockRequest.mock.calls[0][0].timeoutMs).toBe(expected + 3000);
});
test('scroll passes target without to', async () => {
  const target = '["providers","mounted","3"]';
  await tool({ op: 'scroll', target }, {});
  expect(mockRequest.mock.calls[0][0].command).toEqual({ op: 'scroll', target, duration_ms: 600 });
});

test('the retired hooks tab is an alias: it opens Automations, where scripts list', async () => {
  mockRequest.mockResolvedValue({
    success: true,
    state: { open: true, active_tab: 'automations' },
  });
  expect(JSON.parse((await tool({ op: 'open', tab: 'hooks' }, {})) as string)).toEqual({
    success: true,
    open: true,
    active_tab: 'automations',
  });
  expect(mockRequest.mock.calls[0][0].command).toEqual({ op: 'open', tab: 'automations' });
});
test('the hooks alias is still open-only, and the schema accepts it', async () => {
  await expect(tool({ op: 'close', tab: 'hooks' }, {})).rejects.toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
  const { default: definition } =
    await import('@server/services/ToolService/tools/workspace/sidebar/definition');
  const tabSchema = (definition.parameters_schema as { properties: { tab: { enum: string[] } } })
    .properties.tab;
  expect(tabSchema.enum).toEqual(expect.arrayContaining(['automations', 'hooks']));
});
