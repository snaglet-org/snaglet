import type { ToolHandler } from '@server/services/ToolService/types';
import addModel from '@server/services/ToolService/handlers/agents/addModel';
import listModels from '@server/services/ToolService/handlers/agents/listModels';

type Input = Record<string, unknown>;

/** model(op): list (alias id list_models) and add (alias id add_model). */
const OP_FIELDS: Record<string, readonly string[]> = {
  list: ['operation'],
  add: ['model_id', 'display_name', 'context_window_tokens', 'max_output_tokens', 'metadata'],
};
const SHARED_FIELDS = ['op', 'provider_id'];

function refuseForeignFields(op: string, input: Input): void {
  const own = new Set([...SHARED_FIELDS, ...OP_FIELDS[op]]);
  for (const [otherOp, fields] of Object.entries(OP_FIELDS)) {
    if (otherOp === op) continue;
    for (const field of fields) {
      if (!own.has(field) && input[field] !== undefined) {
        throw new Error(
          `model ${op}: \`${field}\` belongs to op ${otherOp}, not ${op}. Nothing was changed.`
        );
      }
    }
  }
}

const strip = ({ op: _op, ...rest }: Input): Input => rest;

const OPS: Record<string, ToolHandler> = {
  list: (input, settings, context) => listModels(strip(input), settings, context),
  add: (input, settings, context) => addModel(strip(input), settings, context),
};

const tool: ToolHandler = async (input, settings, context) => {
  const op = typeof input.op === 'string' ? input.op : undefined;
  const handler = op ? OPS[op] : undefined;
  if (!op || !handler) {
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(', ')}.`);
  }
  refuseForeignFields(op, input);
  return handler(input, settings, context);
};

export default tool;
