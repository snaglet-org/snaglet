/**
 * Model picker order and labels. Within a provider: current models before
 * legacy or deprecated ones; then the newest major version, then the Claude
 * tier (mythos, fable, opus, sonnet, haiku), then the newest minor version,
 * then the list's own order; a `[1m]` variant or a dated snapshot of a listed
 * id follows it; ids with no readable version keep their order after the ones
 * with one. The ids below are real catalog ids, given in the order the
 * database returns them (`sort_order`, then `model_id`).
 */
import { modelOptionLabels, sortModels } from '@snaglet/shared/utils';

const rows = (providerId: string, ids: string[]) => ids.map((modelId) => ({ providerId, modelId }));
const order = (providerId: string, ids: string[]) =>
  sortModels(rows(providerId, ids)).map((m) => m.modelId);

describe('sortModels', () => {
  it('puts the newest Claude generation first, by major version, tier, then minor version', () => {
    // A catalog in database order (sort_order, then model_id), newest rows last.
    const dbOrder = [
      'claude-opus-4-5',
      'claude-opus-4-7',
      'claude-opus-4-7[1m]',
      'claude-opus-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-3-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-3-haiku-20240307',
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-fable-5-2',
      'claude-haiku-4-5-20251001',
      'claude-haiku-5-5',
      'claude-opus-4-1-20250805',
      'claude-opus-4-20250514',
      'claude-opus-4-5-20251101',
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-sonnet-4-20250514',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-5',
      'claude-sonnet-5-5',
    ];
    expect(order('anthropic', dbOrder)).toEqual([
      'claude-fable-5-2',
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-haiku-5-5',
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-opus-4-7',
      'claude-opus-4-7[1m]',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-5-20251101',
      'claude-opus-4-1-20250805',
      'claude-opus-4-20250514',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-20250514',
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-haiku-3-5',
      'claude-3-haiku-20240307',
    ]);
  });

  it('lists legacy and deprecated models after current ones, ordered the same way', () => {
    const catalog = [
      { modelId: 'claude-sonnet-4-5', lifecycle: 'deprecated' },
      { modelId: 'claude-haiku-4-5', lifecycle: 'legacy' },
      { modelId: 'claude-opus-4-8', lifecycle: 'legacy' },
      { modelId: 'claude-sonnet-5-5' },
      { modelId: 'claude-fable-5-2' },
    ].map(({ modelId, lifecycle }) => ({
      providerId: 'anthropic',
      modelId,
      metadata: lifecycle ? { lifecycle } : {},
    }));
    expect(sortModels(catalog).map((m) => m.modelId)).toEqual([
      'claude-fable-5-2',
      'claude-sonnet-5-5',
      'claude-opus-4-8',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
    ]);
  });

  it('puts mythos above fable within a generation', () => {
    expect(
      order('anthropic', ['claude-fable-5-2', 'claude-opus-5-5', 'claude-mythos-5-2'])
    ).toEqual(['claude-mythos-5-2', 'claude-fable-5-2', 'claude-opus-5-5']);
  });

  it('puts a 1M variant right after its base and before the base’s snapshots', () => {
    expect(
      order('anthropic', [
        'claude-opus-4-5-20251101',
        'claude-opus-4-5[1m]',
        'claude-opus-4-5',
        'claude-opus-4-6',
      ])
    ).toEqual([
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-5[1m]',
      'claude-opus-4-5-20251101',
    ]);
  });

  it('orders OpenAI ids newest first within each line and keeps the lines’ order', () => {
    expect(
      order('openai', [
        'gpt-4o',
        'gpt-4o-mini',
        'o3',
        'gpt-4.1',
        'gpt-4o-2024-11-20',
        'gpt-5.4-mini',
        'gpt-5.5',
        'gpt-5.5-pro',
        'gpt-6.2-astra',
        'gpt-audio',
        'o4-mini',
      ])
    ).toEqual([
      'gpt-6.2-astra',
      'gpt-5.5',
      'gpt-5.5-pro',
      'gpt-5.4-mini',
      'gpt-4.1',
      'gpt-4o',
      'gpt-4o-2024-11-20',
      'gpt-4o-mini',
      'o4-mini',
      'o3',
      // No version in the id: kept, after the rest.
      'gpt-audio',
    ]);
  });

  it('orders Gemini ids newest first and keeps tiers of one version in list order', () => {
    expect(
      order('google', ['gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-1.5-pro', 'gemini-3.8-flash'])
    ).toEqual(['gemini-3.8-flash', 'gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-1.5-pro']);
  });

  it('groups Copilot’s mixed catalog by line, newest first, Claude by tier', () => {
    expect(
      order('copilot', [
        'gpt-4.1',
        'gpt-5-mini',
        'claude-haiku-4.5',
        'claude-opus-4.6',
        'claude-opus-4.6-fast',
        'gemini-2.5-pro',
        'claude-fable-5',
        'claude-sonnet-5',
        'gpt-5.6-sol',
        'oswe-vscode-prime',
      ])
    ).toEqual([
      'gpt-5.6-sol',
      'gpt-5-mini',
      'gpt-4.1',
      'claude-fable-5',
      'claude-sonnet-5',
      'claude-opus-4.6',
      'claude-opus-4.6-fast',
      'claude-haiku-4.5',
      'gemini-2.5-pro',
      'oswe-vscode-prime',
    ]);
  });

  it('reads a dotted minor as a decimal, so xAI’s grok-4.20 comes after grok-4.7', () => {
    expect(
      order('xai', [
        'grok-4.20-0309-non-reasoning',
        'grok-4.20-0309-reasoning',
        'grok-4.3',
        'grok-4.5',
        'grok-4.7',
      ])
    ).toEqual([
      'grok-4.7',
      'grok-4.5',
      'grok-4.3',
      'grok-4.20-0309-non-reasoning',
      'grok-4.20-0309-reasoning',
    ]);
  });

  it('keeps ids it cannot read in their order, after the readable ones, without throwing', () => {
    expect(
      order('mistral', [
        'mistral-large-latest',
        'open-mistral-7b',
        'codestral-latest',
        'mistral-medium',
        'mistral-medium-2505',
        'mistral-large-4',
        '',
        '[1m]',
      ])
    ).toEqual([
      'mistral-large-4',
      'mistral-large-latest',
      'open-mistral-7b',
      'codestral-latest',
      'mistral-medium',
      'mistral-medium-2505',
      '',
      '[1m]',
    ]);
  });

  it('keeps each provider’s models together and gives the same list when sorted again', () => {
    const mixed = [
      ...rows('anthropic', ['claude-opus-4-5', 'claude-sonnet-5-5']),
      ...rows('openai', ['gpt-4o', 'gpt-5.5']),
      ...rows('anthropic', ['claude-fable-5-2']),
    ];
    const sorted = sortModels(mixed);
    expect(sorted.map((m) => `${m.providerId}/${m.modelId}`)).toEqual([
      'anthropic/claude-fable-5-2',
      'anthropic/claude-sonnet-5-5',
      'anthropic/claude-opus-4-5',
      'openai/gpt-5.5',
      'openai/gpt-4o',
    ]);
    expect(sortModels(sorted)).toEqual(sorted);
  });
});

describe('modelOptionLabels', () => {
  const labeled = (ids: Array<[string, string]>, providerId = 'anthropic') =>
    ids.map(([modelId, displayName]) => ({ providerId, modelId, displayName }));

  it('adds the snapshot date to a dated id that shares its alias’s name', () => {
    expect(
      modelOptionLabels(
        labeled([
          ['claude-opus-4-5', 'Claude Opus 4.5'],
          ['claude-opus-4-5-20251101', 'Claude Opus 4.5'],
          ['claude-haiku-4-5', 'Claude Haiku 4.5'],
        ])
      )
    ).toEqual(['Claude Opus 4.5', 'Claude Opus 4.5 (20251101)', 'Claude Haiku 4.5']);
  });

  it('keeps the plain name on the model whose id is that name', () => {
    expect(
      modelOptionLabels(
        labeled(
          [
            ['mistral-large-latest', 'mistral-large-2512'],
            ['mistral-large-2512', 'mistral-large-2512'],
          ],
          'mistral'
        )
      )
    ).toEqual(['mistral-large-2512 (mistral-large-latest)', 'mistral-large-2512']);
  });

  it('never shows the same label twice within a provider, and leaves other providers alone', () => {
    const labels = modelOptionLabels([
      ...labeled(
        [
          ['gpt-4o', 'GPT-4o'],
          ['gpt-4o-2024-08-06', 'GPT-4o'],
          ['gpt-4o-2024-11-20', 'GPT-4o'],
        ],
        'openai'
      ),
      { providerId: 'copilot', modelId: 'gpt-4o', displayName: 'GPT-4o' },
    ]);
    expect(labels).toEqual(['GPT-4o', 'GPT-4o (2024-08-06)', 'GPT-4o (2024-11-20)', 'GPT-4o']);
  });

  it('falls back to the id when a model has no display name', () => {
    expect(
      modelOptionLabels([{ providerId: 'ollama', modelId: 'qwen3:4b', displayName: '' }])
    ).toEqual(['qwen3:4b']);
  });
});
