/**
 * The system prompt's Core Tools list does not repeat tool
 * descriptions, because every provider path that sends tools sends them
 * natively with the full description and schema. Pin that for each wire
 * converter: Anthropic, OpenAI chat-completions (openai/ollama/lm-studio/
 * xai/deepseek/together/mistral/copilot via chat-completions.ts), Gemini, and
 * the Responses wire (codex, copilot/responses). apple-on-device ignores tools
 * entirely, so it neither needs nor reads the list.
 */
import type { ToolRow } from '@snaglet/shared/types';
import {
  formatToolsForProvider,
  toAnthropicTools,
  toGeminiTools,
  toOpenAITools,
} from '@server/services/ToolService/ToolFormatService';
import { toResponsesTools } from '@server/services/ProviderChatService/providers/shared/responses-api';
import { createToolNameSanitizer } from '@server/services/ProviderChatService/providers/shared/toolNameSanitizer';

const DESCRIPTION = 'Full native description — the only copy the model gets after T3.';

const row = {
  id: 'search',
  name: 'Search',
  description: DESCRIPTION,
  type: 'builtin',
  tier: 'core',
  categoryPath: 'uncategorized',
  keywords: [],
  aliases: [],
  source: null,
  configJson: {},
  enabled: true,
  parametersSchema: {
    type: 'object',
    required: [],
    properties: { query: { type: 'string', description: 'Search text.' } },
  },
} as unknown as ToolRow;

describe('every tool-sending wire carries the full description natively', () => {
  it('anthropic', () => {
    const [tool] = toAnthropicTools([row]);
    expect(tool).toEqual(expect.objectContaining({ name: 'search', description: DESCRIPTION }));
    expect(JSON.stringify(tool.input_schema)).toContain('Search text.');
  });

  it('openai chat-completions', () => {
    const [tool] = toOpenAITools([row]);
    expect(tool.function).toEqual(
      expect.objectContaining({ name: 'search', description: DESCRIPTION })
    );
    expect(JSON.stringify(tool.function.parameters)).toContain('Search text.');
  });

  it('gemini', () => {
    const json = JSON.stringify(toGeminiTools([row]));
    expect(json).toContain(DESCRIPTION);
    expect(json).toContain('Search text.');
  });

  it('responses (codex, copilot/responses)', () => {
    const [tool] = toResponsesTools([row], createToolNameSanitizer());
    expect(tool).toEqual(expect.objectContaining({ name: 'search', description: DESCRIPTION }));
    expect(JSON.stringify(tool.parameters)).toContain('Search text.');
  });

  it.each(['anthropic', 'openai', 'codex', 'google', 'gemini'])(
    'formatToolsForProvider(%s) keeps the description',
    (provider) => {
      expect(JSON.stringify(formatToolsForProvider(provider, [row]))).toContain(DESCRIPTION);
    }
  );
});
