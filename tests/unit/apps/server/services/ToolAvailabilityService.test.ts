/**
 * ToolAvailabilityService — the availability gate for persisted (builtin) tools
 * used by the tools routes and the assignment UI.
 *
 * MCP tools are not persisted as `tools` rows (they resolve live and
 * bypass this gate), so this only covers builtin tools and their
 * integration-provider credential requirements.
 */
import type { ToolRow } from '@snaglet/db/tables/tools';
import { getToolAvailability } from '@server/services/ToolAvailabilityService';

const mockFindProvider = jest.fn();
const mockFindCredential = jest.fn();

jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: { findById: (...a: unknown[]) => mockFindProvider(...a) },
}));

jest.mock('@snaglet/db/tables/user_provider_credentials', () => ({
  UserProviderCredentials: { findByProviderId: (...a: unknown[]) => mockFindCredential(...a) },
}));

function tool(overrides: Partial<ToolRow>): ToolRow {
  return {
    id: 'github_create_issue',
    type: 'builtin',
    enabled: true,
    providerId: 'github',
    ...overrides,
  } as ToolRow;
}

describe('getToolAvailability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindProvider.mockResolvedValue(null);
    mockFindCredential.mockResolvedValue(null);
  });

  test('disabled tool reports disabled', async () => {
    expect(await getToolAvailability(tool({ enabled: false }))).toBe('disabled');
  });

  test('tool with no provider is always available', async () => {
    expect(await getToolAvailability(tool({ providerId: null }))).toBe('available');
  });

  test('Apple Vision OCR is unavailable on Windows without changing its saved enabled policy', async () => {
    const ocr = tool({ id: 'ocr_image', providerId: null, enabled: true });
    expect(await getToolAvailability(ocr, 'win32')).toBe('unsupported_platform');
    expect(ocr.enabled).toBe(true);
    expect(mockFindProvider).not.toHaveBeenCalled();
  });

  test('Apple Vision OCR remains available on macOS', async () => {
    expect(await getToolAvailability(tool({ id: 'ocr_image', providerId: null }), 'darwin')).toBe(
      'available'
    );
  });

  test('non-integration provider needs no credential', async () => {
    mockFindProvider.mockResolvedValue({ type: 'llm', enabled: true });
    expect(await getToolAvailability(tool({ providerId: 'openai' }))).toBe('available');
    expect(mockFindCredential).not.toHaveBeenCalled();
  });

  test('disabled integration provider reports integration_disabled', async () => {
    mockFindProvider.mockResolvedValue({ type: 'integration', enabled: false });
    expect(await getToolAvailability(tool({}))).toBe('integration_disabled');
  });

  test('integration without a credential reports missing_credential', async () => {
    mockFindProvider.mockResolvedValue({ type: 'integration', enabled: true });
    mockFindCredential.mockResolvedValue(null);
    expect(await getToolAvailability(tool({}))).toBe('missing_credential');
  });

  test('integration with a credential is available', async () => {
    mockFindProvider.mockResolvedValue({ type: 'integration', enabled: true });
    mockFindCredential.mockResolvedValue({ id: 'cred-1' });
    expect(await getToolAvailability(tool({}))).toBe('available');
  });
});
