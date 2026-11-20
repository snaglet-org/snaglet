import type { ToolHandler } from '@server/services/ToolService/types';

/**
 * Route a flat capability schema to its existing per-operation handlers.
 *
 * Some integration handlers predate the common ToolHandler type and declare
 * narrower input interfaces. The registry has always invoked those modules
 * with the ToolHandler calling convention, so the cast stays isolated here
 * while preserving their runtime behavior unchanged.
 */
export function createCapabilityRouter(
  handlers: Readonly<Record<string, unknown>>,
  discriminator = 'operation'
): ToolHandler {
  return async (input, settings, context) => {
    const operation = input[discriminator];
    if (typeof operation !== 'string' || !operation) {
      throw new Error(`${discriminator} is required`);
    }

    const handler = handlers[operation] as ToolHandler | undefined;
    if (!handler) {
      throw new Error(
        `Unsupported ${discriminator} "${operation}". Expected one of: ${Object.keys(handlers).join(', ')}`
      );
    }

    const forwarded = { ...input };
    delete forwarded[discriminator];
    return handler(forwarded, settings, context);
  };
}
