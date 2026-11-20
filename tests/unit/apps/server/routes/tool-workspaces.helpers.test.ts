import { Tools } from '@snaglet/db/tables/tools';
import { syncDefinitionToDb } from '@server/domains/tools/routes/helpers';

jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: {
    upsertTool: jest.fn(),
    setEnabled: jest.fn(),
  },
}));

describe('syncDefinitionToDb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('explicitly settles workspace-owned enabled state after the metadata upsert', async () => {
    jest.mocked(Tools.upsertTool).mockResolvedValue({ id: 'demo_tool' } as never);
    jest.mocked(Tools.setEnabled).mockResolvedValue({ id: 'demo_tool', enabled: true } as never);

    const row = await syncDefinitionToDb(
      'demo-tool',
      JSON.stringify({ name: 'demo-tool', description: 'Demo' }),
      { enabled: true }
    );

    expect(Tools.upsertTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'demo_tool', source: 'workspace:demo-tool', enabled: true })
    );
    expect(Tools.setEnabled).toHaveBeenCalledWith('demo_tool', true);
    expect(row).toEqual(expect.objectContaining({ id: 'demo_tool', enabled: true }));
  });
});
