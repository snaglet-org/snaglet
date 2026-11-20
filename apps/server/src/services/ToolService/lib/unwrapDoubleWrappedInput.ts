/**
 * unwrapDoubleWrappedInput: some models (notably small local ones) wrap tool
 * input in the call envelope, `{ "function_name": "create_doc", "arguments":
 * { … } }`. Returns the inner object only when exactly one name key names the
 * invoked tool (case- and separator-insensitive), exactly one args key holds a
 * plain object, and no other key has a value. No builtin declares an args key
 * or `function_name` as a parameter (definitionWrapperKeys.guard.test.ts), so
 * a legitimate call never matches; for MCP tools the exact shape is the guard.
 */

import { isRecord } from '@snaglet/shared/utils/type-guards';

const WRAPPER_NAME_KEYS = ['function_name', 'name', 'tool'] as const;
export const WRAPPER_ARGS_KEYS = ['arguments', 'args', 'parameters'] as const;

/**
 * Canonical form for same-tool comparison: lowercase, separators stripped —
 * `create_doc`, `createDoc`, and `Create Doc` all become `createdoc`. Still
 * requires naming the same tool; only the separator style is forgiven.
 */
function canonicalToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface DoubleWrapUnwrapResult {
  /** The inner arguments object the model actually meant to send. */
  input: Record<string, unknown>;
  /** Which wrapper key named the tool (`function_name` | `name` | `tool`). */
  nameKey: string;
  /** Which wrapper key carried the args (`arguments` | `args` | `parameters`). */
  argsKey: string;
  /** The tool name the wrapper carried (trimmed, as sent). */
  wrapperToolName: string;
}

/**
 * Detect a double-wrapped tool input and return the inner arguments object,
 * or `null` when the input is not that exact shape (the common case).
 *
 * @param input - The raw tool call input object.
 * @param invokedToolIds - Every id/name the current invocation is known by
 *   (call name, alias-resolved id, resolved tool row id). Falsy entries are
 *   ignored so callers can pass optional candidates unconditionally.
 */
export function unwrapDoubleWrappedInput(
  input: Record<string, unknown>,
  invokedToolIds: ReadonlyArray<string | undefined>
): DoubleWrapUnwrapResult | null {
  if (!isRecord(input)) return null;

  const presentNameKeys = WRAPPER_NAME_KEYS.filter((key) => input[key] !== undefined);
  const presentArgsKeys = WRAPPER_ARGS_KEYS.filter((key) => input[key] !== undefined);
  if (presentNameKeys.length !== 1 || presentArgsKeys.length !== 1) return null;

  const nameKey = presentNameKeys[0];
  const argsKey = presentArgsKeys[0];

  const rawWrapperName = input[nameKey];
  if (typeof rawWrapperName !== 'string' || rawWrapperName.trim().length === 0) return null;
  const wrapperToolName = rawWrapperName.trim();

  const inner = input[argsKey];
  if (!isRecord(inner)) return null;

  // "Nothing else meaningful": any other key must be undefined-valued.
  for (const key of Object.keys(input)) {
    if (key !== nameKey && key !== argsKey && input[key] !== undefined) return null;
  }

  // The wrapper must name the same tool being invoked.
  const wrapped = canonicalToolName(wrapperToolName);
  if (wrapped.length === 0) return null;
  const namesInvokedTool = invokedToolIds.some(
    (candidate) =>
      typeof candidate === 'string' && candidate && canonicalToolName(candidate) === wrapped
  );
  if (!namesInvokedTool) return null;

  return { input: inner, nameKey, argsKey, wrapperToolName };
}
