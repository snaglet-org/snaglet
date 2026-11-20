/**
 * Guard: no builtin tool definition may declare a wrapper args key.
 *
 * unwrapDoubleWrappedInput (ToolExecutor) leniently unwraps the small-model
 * double-wrap `{function_name, arguments}` before validation. That is safe
 * only while no builtin declares `arguments`, `args`, `parameters` or
 * `function_name` as a parameter. If this fails, rename the new parameter or
 * rethink the unwrap's key lists, or real calls to that tool become eligible
 * for false unwrapping. `name` and `tool` (wrapper name keys) are allowed:
 * the exact-shape rule (name value + args-key object + nothing else) keeps
 * those safe.
 */
import { loadRegistryEntries } from '@server/services/ToolService/registry-source';
import { WRAPPER_ARGS_KEYS } from '@server/services/ToolService/lib/unwrapDoubleWrappedInput';

const FORBIDDEN_PARAM_NAMES = new Set<string>([...WRAPPER_ARGS_KEYS, 'function_name']);

describe('builtin definitions never declare wrapper args keys', () => {
  it('no definition parameter collides with the unwrap key lists', async () => {
    const entries = await loadRegistryEntries();
    expect(entries.length).toBeGreaterThan(0);

    const collisions: string[] = [];
    for (const entry of entries) {
      const schema = entry.definition?.parameters_schema;
      if (!schema || typeof schema !== 'object') continue;
      const properties = (schema as { properties?: Record<string, unknown> }).properties;
      if (!properties || typeof properties !== 'object') continue;
      for (const paramName of Object.keys(properties)) {
        if (FORBIDDEN_PARAM_NAMES.has(paramName)) {
          collisions.push(`${entry.toolId}.${paramName}`);
        }
      }
    }

    expect(collisions).toEqual([]);
  });
});
