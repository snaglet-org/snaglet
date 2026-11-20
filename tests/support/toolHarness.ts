/**
 * Typed test harness for built-in tool handlers.
 *
 * Every workspace tool unit test drives a `ToolHandler` the same way: build an
 * arbitrary (possibly deliberately invalid) input object, invoke the handler
 * with empty settings/context, then unwrap the result — `rawContent` when the
 * handler returns a rich result, otherwise `JSON.parse` of the string output.
 * Before this helper each suite hand-rolled that shape with `any` casts; this
 * module centralizes it with real types.
 *
 * `input` is typed `unknown` on purpose: handlers validate their input at
 * runtime (that validation is exactly what many tests exercise), so the
 * harness is the one sanctioned boundary where an arbitrary value is handed
 * to the `Record<string, unknown>` parameter.
 */

import type {
  ToolHandler,
  ToolHandlerContext,
  ToolHandlerRichResult,
} from '@server/services/ToolService/types';

export type { ToolHandler, ToolHandlerContext, ToolHandlerRichResult };

/** What a `ToolHandler` resolves to. */
export type ToolOutput = string | ToolHandlerRichResult;

/**
 * Invoke a tool handler the way the executor does. Settings and context
 * default to empty objects — the common case in unit tests.
 */
export function invokeTool(
  tool: ToolHandler,
  input: unknown,
  context: ToolHandlerContext = {},
  settings: Record<string, unknown> = {}
): Promise<ToolOutput> {
  return tool(input as Record<string, unknown>, settings, context);
}

/**
 * Unwrap a tool result into its structured payload: `rawContent` when the
 * handler returned a rich result, else `JSON.parse` of the string output.
 * `T` should describe the fields the test asserts on.
 */
export function parseToolResult<T = Record<string, unknown>>(out: unknown): T {
  if (out && typeof out === 'object' && 'rawContent' in out) {
    return (out as ToolHandlerRichResult).rawContent as T;
  }
  if (typeof out === 'string') return JSON.parse(out) as T;
  return out as T;
}

/** The text surface the model sees: `output` of a rich result, else the string itself. */
export function toolOutputText(out: ToolOutput): string {
  return typeof out === 'string' ? out : out.output;
}

/** Invoke + unwrap in one step for tests that only care about the payload. */
export async function runTool<T = Record<string, unknown>>(
  tool: ToolHandler,
  input: unknown,
  context: ToolHandlerContext = {}
): Promise<T> {
  return parseToolResult<T>(await invokeTool(tool, input, context));
}
