/**
 * modelProvenance — parsing the `model_used` stamp a thread summary carries.
 *
 * The stamp is written once by SummaryService and then read by two surfaces
 * that are far apart (the summary card, the exported transcript). What matters
 * here is the three shapes those surfaces actually receive from real rows:
 * a provider-qualified stamp, a null stamp (an older row), and a malformed
 * stamp with no separator. The last two
 * must never render a bare `/`.
 */

import { formatModelUsed, parseModelUsed } from '@snaglet/shared/utils';

describe('parseModelUsed', () => {
  it('splits a normal provider/model stamp', () => {
    expect(parseModelUsed('anthropic/claude-opus-4')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-opus-4',
    });
  });

  it('keeps a publisher-qualified model id whole by splitting on the first slash only', () => {
    // LM Studio ids are themselves `publisher/model`; splitting on every slash
    // would truncate the model name to "qwen".
    expect(parseModelUsed('lmstudio/qwen/qwen3-4b')).toEqual({
      providerId: 'lmstudio',
      modelId: 'qwen/qwen3-4b',
    });
  });

  it('returns null for a null stamp, so the caller renders nothing', () => {
    expect(parseModelUsed(null)).toBeNull();
    expect(parseModelUsed(undefined)).toBeNull();
  });

  it('keeps a malformed stamp with no slash as the model name', () => {
    // A row that names a model but no provider still names something real.
    expect(parseModelUsed('qwen2.5:3b')).toEqual({ providerId: null, modelId: 'qwen2.5:3b' });
  });

  it('returns null when there is nothing to name', () => {
    expect(parseModelUsed('')).toBeNull();
    expect(parseModelUsed('   ')).toBeNull();
    // A lone separator is the exact value that would render as a bare slash.
    expect(parseModelUsed('/')).toBeNull();
    expect(parseModelUsed(' / ')).toBeNull();
  });

  it('drops a half-empty stamp down to whichever half says something', () => {
    expect(parseModelUsed('anthropic/')).toEqual({ providerId: null, modelId: 'anthropic' });
    expect(parseModelUsed('/gpt-5')).toEqual({ providerId: null, modelId: 'gpt-5' });
  });

  it('trims surrounding whitespace on both halves', () => {
    expect(parseModelUsed('  openai / gpt-5  ')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5',
    });
  });
});

describe('formatModelUsed', () => {
  it('formats a normal provider/model stamp', () => {
    expect(formatModelUsed('anthropic/claude-opus-4')).toBe('anthropic/claude-opus-4');
    expect(formatModelUsed('  openai / gpt-5  ')).toBe('openai/gpt-5');
  });

  it('formats a null stamp as null, never a placeholder', () => {
    expect(formatModelUsed(null)).toBeNull();
    expect(formatModelUsed(undefined)).toBeNull();
  });

  it('formats a malformed stamp as the raw token, never a bare slash', () => {
    expect(formatModelUsed('qwen2.5:3b')).toBe('qwen2.5:3b');
    expect(formatModelUsed('anthropic/')).toBe('anthropic');
    expect(formatModelUsed('/gpt-5')).toBe('gpt-5');
  });

  it('never emits a lone separator for any degenerate input', () => {
    for (const input of [null, undefined, '', '   ', '/', ' / ', '//']) {
      const out = formatModelUsed(input);
      expect(out === null || out.trim() !== '').toBe(true);
      expect(out).not.toBe('/');
    }
  });
});
