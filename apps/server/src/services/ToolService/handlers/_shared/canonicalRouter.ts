import type { ToolHandler } from '@server/services/ToolService/types';

export type CanonicalOperation = {
  handler: ToolHandler;
  fields: readonly string[];
  required?: readonly (string | readonly string[])[];
};

export function createCanonicalRouter(
  operations: Record<string, CanonicalOperation>,
  name: string
): ToolHandler {
  return async (input, settings, context) => {
    const op = input.op;
    if (typeof op !== 'string' || !op) throw new Error(`${name}: op is required`);
    const route = operations[op];
    if (!route) throw new Error(`${name}: unsupported op "${op}"`);

    const allowed = new Set(['op', ...route.fields]);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new Error(`${name}: field(s) ${unknown.join(', ')} are not valid for op "${op}"`);
    }
    for (const requirement of route.required ?? []) {
      const keys = Array.isArray(requirement) ? requirement : [requirement];
      if (!keys.some((key) => input[key] !== undefined && input[key] !== null)) {
        throw new Error(
          `${name}: one of ${keys.map((key) => `\`${key}\``).join(', ')} is required for op "${op}"`
        );
      }
    }

    const forwarded = { ...input } as Record<string, unknown>;
    delete forwarded.op;
    return route.handler(forwarded, settings, context);
  };
}
