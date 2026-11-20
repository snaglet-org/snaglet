import {
  toAnthropicTools,
  toOpenAITools,
  toGeminiTools,
  formatToolsForProvider,
  normalizeAnthropicInputSchema,
  measureAnthropicToolCatalog,
} from '@server/services/ToolService/ToolFormatService';

// Minimal ToolRow fixture
function makeToolRow(
  overrides: Partial<{
    id: string;
    description: string;
    parameters_schema: Record<string, unknown>;
  }> = {}
) {
  return {
    id: overrides.id ?? 'file_read',
    name: 'File Read',
    description: overrides.description ?? 'Read a file from disk',
    type: 'builtin',
    enabled: true,
    parameters_schema: overrides.parameters_schema ?? {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    config_json: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as Parameters<typeof toAnthropicTools>[0][number];
}

const sampleTools = [
  makeToolRow({ id: 'file_read', description: 'Read a file' }),
  makeToolRow({
    id: 'shell_exec',
    description: 'Run a shell command',
    parameters_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  }),
];

describe('ToolFormatService', () => {
  describe('toAnthropicTools', () => {
    it('should map tools to Anthropic format', () => {
      const result = toAnthropicTools(sampleTools);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        type: 'custom',
        name: 'file_read',
        description: 'Read a file',
        input_schema: sampleTools[0].parameters_schema,
      });
    });

    it('should return empty array for no tools', () => {
      expect(toAnthropicTools([])).toEqual([]);
    });

    it('removes unsupported root alternatives without mutating the canonical schema', () => {
      const schema = {
        type: 'object',
        properties: {
          patch: { type: 'string' },
          input: { type: 'string' },
        },
        anyOf: [{ required: ['patch'] }, { required: ['input'] }],
      };

      const normalized = normalizeAnthropicInputSchema(schema);

      expect(normalized).toEqual({
        type: 'object',
        properties: schema.properties,
      });
      expect(schema).toHaveProperty('anyOf');
    });

    it('merges allOf fields and requirements into the root object', () => {
      const normalized = normalizeAnthropicInputSchema({
        allOf: [
          {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
          {
            type: 'object',
            properties: { force: { type: 'boolean' } },
            required: ['force'],
          },
        ],
      });

      expect(normalized).toEqual({
        type: 'object',
        properties: {
          path: { type: 'string' },
          force: { type: 'boolean' },
        },
        required: ['path', 'force'],
      });
    });

    it('keeps only requirements shared by every oneOf alternative', () => {
      const normalized = normalizeAnthropicInputSchema({
        oneOf: [
          {
            properties: { mode: { const: 'read' }, path: { type: 'string' } },
            required: ['mode', 'path'],
          },
          {
            properties: { mode: { const: 'write' }, content: { type: 'string' } },
            required: ['mode', 'content'],
          },
        ],
      });

      expect(normalized).toMatchObject({
        type: 'object',
        required: ['mode'],
        properties: {
          mode: { enum: ['read', 'write'] },
          path: { type: 'string' },
          content: { type: 'string' },
        },
      });
      expect(normalized).not.toHaveProperty('oneOf');
    });
  });

  describe('measureAnthropicToolCatalog', () => {
    it('reports the exact serialized tool-block bytes and a stable byte/4 estimate', () => {
      const expectedBytes = Buffer.byteLength(
        JSON.stringify(toAnthropicTools(sampleTools)),
        'utf8'
      );

      expect(measureAnthropicToolCatalog(sampleTools)).toEqual({
        toolCount: 2,
        serializedBytes: expectedBytes,
        estimatedTokens: Math.ceil(expectedBytes / 4),
      });
    });
  });

  describe('toOpenAITools', () => {
    it('should map tools to OpenAI function-calling format', () => {
      const result = toOpenAITools(sampleTools);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        type: 'function',
        function: {
          name: 'file_read',
          description: 'Read a file',
          parameters: sampleTools[0].parameters_schema,
        },
      });
    });

    it('should set type to "function" on every entry', () => {
      const result = toOpenAITools(sampleTools);
      result.forEach((t) => expect(t.type).toBe('function'));
    });

    // The apply_patch tool carries a top-level anyOf that strict OpenAI-style
    // backends (Copilot, Codex, gemini-via-copilot) 400 on.
    const applyPatchSchema = {
      type: 'object',
      properties: {
        patch: { type: 'string' },
        input: { type: 'string' },
        workdir: { type: 'string' },
      },
      anyOf: [{ required: ['patch'] }, { required: ['input'] }],
    };
    const applyPatchTool = makeToolRow({ id: 'apply_patch', parameters_schema: applyPatchSchema });

    it('leaves top-level combinators verbatim by default (canonical OpenAI wire)', () => {
      const [tool] = toOpenAITools([applyPatchTool]);
      expect(tool.function.parameters).toHaveProperty('anyOf');
    });

    it('flattens top-level anyOf when flattenSchemas is set (strict wires)', () => {
      const [tool] = toOpenAITools([applyPatchTool], { flattenSchemas: true });
      const params = tool.function.parameters;
      expect(params).not.toHaveProperty('anyOf');
      // apply_patch's params still round-trip: every property survives.
      expect(params).toMatchObject({
        type: 'object',
        properties: {
          patch: { type: 'string' },
          input: { type: 'string' },
          workdir: { type: 'string' },
        },
      });
      // The canonical schema is never mutated.
      expect(applyPatchSchema).toHaveProperty('anyOf');
    });
  });

  describe('toGeminiTools', () => {
    it('should wrap tools in functionDeclarations', () => {
      const result = toGeminiTools(sampleTools);

      expect(result).toHaveProperty('functionDeclarations');
      expect(result.functionDeclarations).toHaveLength(2);
      expect(result.functionDeclarations[0]).toEqual({
        name: 'file_read',
        description: 'Read a file',
        parameters: sampleTools[0].parameters_schema,
      });
    });

    it('should return empty functionDeclarations for no tools', () => {
      const result = toGeminiTools([]);
      expect(result.functionDeclarations).toEqual([]);
    });
  });

  describe('formatToolsForProvider', () => {
    it('should return null for empty tools array', () => {
      expect(formatToolsForProvider('anthropic', [])).toBeNull();
    });

    it('should route "anthropic" to Anthropic format', () => {
      const result = formatToolsForProvider('anthropic', sampleTools);
      expect(result).toEqual(toAnthropicTools(sampleTools));
    });

    it('should route "openai" to OpenAI format', () => {
      const result = formatToolsForProvider('openai', sampleTools);
      expect(result).toEqual(toOpenAITools(sampleTools));
    });

    it('should route "codex" to OpenAI format', () => {
      const result = formatToolsForProvider('codex', sampleTools);
      expect(result).toEqual(toOpenAITools(sampleTools));
    });

    it('should route "google" to Gemini format', () => {
      const result = formatToolsForProvider('google', sampleTools);
      expect(result).toEqual(toGeminiTools(sampleTools));
    });

    it('should route "gemini" to Gemini format', () => {
      const result = formatToolsForProvider('gemini', sampleTools);
      expect(result).toEqual(toGeminiTools(sampleTools));
    });

    it('should be case-insensitive', () => {
      const result = formatToolsForProvider('ANTHROPIC', sampleTools);
      expect(result).toEqual(toAnthropicTools(sampleTools));
    });

    it('should return null for unknown provider', () => {
      expect(formatToolsForProvider('mistral', sampleTools)).toBeNull();
    });
  });
});
