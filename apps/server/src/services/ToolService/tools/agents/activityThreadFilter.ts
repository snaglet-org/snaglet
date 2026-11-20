import type { ToolHandlerContext } from '@server/services/ToolService/types';

export function resolveActivityThreadId(
  params: Record<string, unknown>,
  context?: ToolHandlerContext
): string | undefined {
  // thread_id: undefined = current thread, null = all threads, string = specific thread
  if (Object.prototype.hasOwnProperty.call(params, 'thread_id')) {
    const threadId = params.thread_id;
    if (threadId === null) return undefined; // all threads
    if (typeof threadId === 'string' && threadId.trim().length > 0) {
      return threadId.trim(); // specific thread
    }
    throw new Error('thread_id must be a non-empty string or null');
  }

  return context?.threadId; // current thread (default)
}
