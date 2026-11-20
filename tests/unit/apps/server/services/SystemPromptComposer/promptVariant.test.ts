/**
 * promptVariant — the eval runner's B/C seam. Pins: (1) with no variant the
 * composer output is untouched (production path), (2) a variant applies its
 * exact diff and nothing else, (3) a candidate that fails to apply throws
 * instead of silently running baseline, (4) the gate refuses outside tests.
 */

const mockIsSemanticSearch = jest.fn();

jest.mock('@server/services/SystemPromptComposer/blocks/toolCatalogBlock', () => {
  const actual = jest.requireActual(
    '@server/services/SystemPromptComposer/blocks/toolCatalogBlock'
  );
  return { __esModule: true, ...actual, isSemanticSearchAvailable: () => mockIsSemanticSearch() };
});

const mockWarn = jest.fn();
jest.mock('@server/config/logger', () => ({
  logger: {
    warn: (...a: unknown[]) => mockWarn(...a),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { composeSystemPrompt } from '@server/services/SystemPromptComposer/composeSystemPrompt';
import {
  applyPromptVariant,
  getPromptVariant,
  promptVariantsEnabled,
  resetPromptVariantWarningForTests,
  setPromptVariant,
} from '@server/services/SystemPromptComposer/promptVariant';
import { makeCtx } from './composeFixtures';

const FEWEST = 'issue independent calls together';

beforeEach(() => {
  mockIsSemanticSearch.mockReset();
  mockIsSemanticSearch.mockResolvedValue(true);
  setPromptVariant(null);
});
afterAll(() => setPromptVariant(null));

describe('promptVariant', () => {
  it('no variant: composeSystemPrompt output is byte-identical to baseline', async () => {
    const a = await composeSystemPrompt(makeCtx());
    const b = await composeSystemPrompt(makeCtx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(getPromptVariant()).toBeNull();
  });

  it('a variant changes exactly its find text and keeps cache_control placement', async () => {
    const base = await composeSystemPrompt(makeCtx());
    setPromptVariant({ id: 'C-test', edits: [{ find: FEWEST, replace: 'CANDIDATE RULE' }] });
    const cand = await composeSystemPrompt(makeCtx());

    expect(cand).toHaveLength(base.length);
    const baseText = base.map((b) => b.text).join('\n');
    const candText = cand.map((b) => b.text).join('\n');
    expect(baseText).toContain(FEWEST);
    expect(candText).not.toContain(FEWEST);
    expect(candText).toBe(baseText.replace(FEWEST, 'CANDIDATE RULE'));
    expect(cand.map((b) => b.cache_control ?? null)).toEqual(
      base.map((b) => b.cache_control ?? null)
    );
  });

  it('throws when an edit does not match (no silent fallback to baseline)', async () => {
    setPromptVariant({
      id: 'C-miss',
      edits: [{ find: 'text that is not in the prompt', replace: 'x' }],
    });
    await expect(composeSystemPrompt(makeCtx())).rejects.toThrow(/expected 1 match, found 0/);
  });

  it('throws when an edit matches more than once', () => {
    const blocks = [
      { type: 'text' as const, text: 'rule A. rule A.' },
      { type: 'text' as const, text: 'other' },
    ];
    expect(() =>
      applyPromptVariant(blocks, { id: 'C-dup', edits: [{ find: 'rule A.', replace: '' }] })
    ).toThrow(/found 2/);
  });

  it('is pure: never mutates the input blocks', () => {
    const blocks = [{ type: 'text' as const, text: 'keep me' }];
    applyPromptVariant(blocks, { id: 'C', edits: [{ find: 'keep', replace: 'drop' }] });
    expect(blocks[0]!.text).toBe('keep me');
  });

  it('replacement text is literal (no $& / $1 expansion)', () => {
    const out = applyPromptVariant([{ type: 'text', text: 'a X b' }], {
      id: 'C',
      edits: [{ find: 'X', replace: '$& $1' }],
    });
    expect(out[0]!.text).toBe('a $& $1 b');
  });

  it('is gated: refuses outside test unless SNAGLET_ENABLE_PROMPT_VARIANTS=1', () => {
    const env = process.env.NODE_ENV;
    const flag = process.env.SNAGLET_ENABLE_PROMPT_VARIANTS;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.SNAGLET_ENABLE_PROMPT_VARIANTS;
      expect(promptVariantsEnabled()).toBe(false);
      expect(() => setPromptVariant({ id: 'C', edits: [] })).toThrow(/test-only/);
      expect(getPromptVariant()).toBeNull();
      process.env.SNAGLET_ENABLE_PROMPT_VARIANTS = '1';
      expect(promptVariantsEnabled()).toBe(true);
    } finally {
      process.env.NODE_ENV = env;
      if (flag === undefined) delete process.env.SNAGLET_ENABLE_PROMPT_VARIANTS;
      else process.env.SNAGLET_ENABLE_PROMPT_VARIANTS = flag;
    }
  });

  it('warns exactly once when enabled via the env flag outside tests, never in tests', () => {
    const env = process.env.NODE_ENV;
    const flag = process.env.SNAGLET_ENABLE_PROMPT_VARIANTS;
    try {
      mockWarn.mockClear();
      resetPromptVariantWarningForTests();

      process.env.NODE_ENV = 'test';
      process.env.SNAGLET_ENABLE_PROMPT_VARIANTS = '1';
      expect(promptVariantsEnabled()).toBe(true);
      expect(mockWarn).not.toHaveBeenCalled();

      process.env.NODE_ENV = 'production';
      delete process.env.SNAGLET_ENABLE_PROMPT_VARIANTS;
      expect(promptVariantsEnabled()).toBe(false);
      expect(mockWarn).not.toHaveBeenCalled();

      process.env.SNAGLET_ENABLE_PROMPT_VARIANTS = '1';
      expect(promptVariantsEnabled()).toBe(true);
      expect(promptVariantsEnabled()).toBe(true);
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(String(mockWarn.mock.calls[0]![0])).toContain('SNAGLET_ENABLE_PROMPT_VARIANTS');
    } finally {
      process.env.NODE_ENV = env;
      if (flag === undefined) delete process.env.SNAGLET_ENABLE_PROMPT_VARIANTS;
      else process.env.SNAGLET_ENABLE_PROMPT_VARIANTS = flag;
    }
  });
});
