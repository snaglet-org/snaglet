import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'generate_chart',
  name: 'Generate Chart',
  description:
    'Create a simple SVG chart from labeled numeric data. Returns SVG markup or writes it to outputPath.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['chart', 'generate', 'graph', 'plot', 'visualize', 'data', 'diagram'],
  parameters_schema: {
    type: 'object',
    required: ['type', 'data'],
    properties: {
      data: {
        type: 'object',
        description:
          'Chart data: { labels: string[], datasets: [{ label: string, values: number[] }] }',
      },
      type: {
        enum: ['bar', 'line', 'pie', 'scatter', 'area', 'histogram'],
        type: 'string',
        description: 'Chart type',
      },
      title: {
        type: 'string',
        description: 'Chart title',
      },
      options: {
        type: 'object',
        description: 'Additional chart options (colors, axes labels, legend position, etc.)',
      },
      outputPath: {
        type: 'string',
        description: 'Optional file path to save the generated SVG',
      },
    },
  },
  sort_order: 27,
};

export default definition;
