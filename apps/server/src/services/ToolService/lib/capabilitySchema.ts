import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

type JsonSchema = Record<string, unknown>;

export interface CapabilityOperation {
  operation: string;
  definition: Pick<BuiltinToolDefinition, 'parameters_schema'>;
}

function mergePropertySchema(left: unknown, right: unknown): unknown {
  if (left === undefined) return right;
  if (right === undefined || JSON.stringify(left) === JSON.stringify(right)) return left;
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) ||
    Array.isArray(right)
  ) {
    return left;
  }

  const a = left as JsonSchema;
  const b = right as JsonSchema;
  const merged: JsonSchema = { ...a };
  const types = [...new Set([a.type, b.type].flat().filter(Boolean))];
  if (types.length === 1) merged.type = types[0];
  else if (types.length > 1) merged.type = types;
  const enums = [
    ...(Array.isArray(a.enum) ? a.enum : []),
    ...(Array.isArray(b.enum) ? b.enum : []),
  ];
  if (enums.length > 0) merged.enum = [...new Set(enums)];
  if (!merged.description && typeof b.description === 'string') merged.description = b.description;
  return merged;
}

export function buildFlatCapabilitySchema(
  operations: readonly CapabilityOperation[],
  discriminator = 'operation'
): JsonSchema {
  const properties: JsonSchema = {
    [discriminator]: {
      type: 'string',
      enum: operations.map(({ operation }) => operation),
      description: 'Capability operation. Operation-specific required fields are listed below.',
    },
  };

  for (const { definition } of operations) {
    const schemaProperties = definition.parameters_schema.properties;
    if (
      !schemaProperties ||
      typeof schemaProperties !== 'object' ||
      Array.isArray(schemaProperties)
    ) {
      continue;
    }
    for (const [name, schema] of Object.entries(schemaProperties)) {
      properties[name] = mergePropertySchema(properties[name], schema);
    }
  }

  return {
    type: 'object',
    properties,
    required: [discriminator],
    additionalProperties: false,
  };
}

export function describeOperationRequirements(operations: readonly CapabilityOperation[]): string {
  return operations
    .map(({ operation, definition }) => {
      const required = Array.isArray(definition.parameters_schema.required)
        ? definition.parameters_schema.required.filter(
            (value): value is string => typeof value === 'string'
          )
        : [];
      return `${operation}: ${required.length > 0 ? `requires ${required.join(', ')}` : 'no required fields'}`;
    })
    .join('; ');
}
