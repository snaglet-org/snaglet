import type { ToolRow } from '@snaglet/db/tables/tools';

export interface TextMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Structural marker for the per-turn ephemeral tail (the turn-context
   * block). These messages are rebuilt every wake and never
   * persisted/replayed, so a prompt-cache entry that spans them can never match
   * next run; the durable cache breakpoint must land before them.
   *
   * This flag is the authoritative signal for that placement
   * (applyMessageCacheBreakpoints); sniffing content for sentinel substrings
   * would misfire on a sentinel phrase quoted in history and slide the
   * breakpoint backwards. Undefined/false = a normal, cacheable message.
   */
  ephemeral?: boolean;
}

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
}

export type UserContentBlock = TextContentBlock | ImageContentBlock;

interface MultimodalUserMessage {
  role: 'user';
  content: UserContentBlock[];
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool-result body. A plain string is the common case; an array of
 * content blocks lets a tool return mixed text+image (or text+text)
 * content inline in the tool_result block, so a vision-capable model can
 * actually see the bytes without burning a follow-up turn.
 *
 * Anthropic accepts arrays natively. Providers that don't (OpenAI's tool
 * role only accepts string) flatten back to text in their adapter — they
 * lose the image, but the text mention reaches the model.
 */
export type ToolResultContent = string | UserContentBlock[];

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
}

/**
 * Collapse a `ToolResultContent` (possibly an array carrying image blocks)
 * back to a single string. Used by providers whose tool-result wire format
 * is text-only (OpenAI Chat Completions, OpenAI Responses, Gemini's
 * functionResponse). Image blocks are replaced with a `[image attached]`
 * marker so the model still knows something visual was returned, even
 * though it can't see it on this provider.
 */
export function flattenToolResultContentToText(content: ToolResultContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'image') return '[image attached — not visible on this provider]';
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Split a `ToolResultContent` into its text and image blocks. Providers whose
 * tool-result channel is text-only (OpenAI Chat Completions & Responses,
 * Gemini) put `text` in the tool result and re-emit `images` as a FOLLOWING
 * user message, so vision-capable models still see the bytes — read once, with
 * no base64 in the text channel.
 */
export function splitToolResultContent(content: ToolResultContent): {
  text: string;
  images: ImageContentBlock[];
} {
  if (typeof content === 'string') return { text: content, images: [] };
  const textParts: string[] = [];
  const images: ImageContentBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') textParts.push(part.text);
    else if (part.type === 'image') images.push(part);
  }
  return { text: textParts.filter(Boolean).join('\n\n'), images };
}

/**
 * A thinking block from an Anthropic response, kept byte-for-byte (signature
 * included) so the tool loop can send it back with the tool_use it preceded.
 * Other providers skip these blocks.
 */
type ThinkingReplayBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

/** One block of an assistant turn in the tool loop. */
export type AssistantTurnBlock =
  | { type: 'text'; text: string }
  | ToolUseBlock
  | ThinkingReplayBlock;

interface AssistantToolMessage {
  role: 'assistant';
  content: AssistantTurnBlock[];
}

interface ToolResultMessage {
  role: 'user';
  content: ToolResultBlock[];
}

export type ProviderMessage =
  | TextMessage
  | MultimodalUserMessage
  | AssistantToolMessage
  | ToolResultMessage;

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderChatResult {
  reply: string;
  toolCalls?: ToolCall[];
  stopReason?: 'end_turn' | 'tool_use' | 'stop' | string;
  /**
   * The response's blocks in order, thinking blocks included, when the run
   * continues from this turn (tool use, or a reply cut off at the output
   * limit) and it carries thinking that must go back with it (Anthropic).
   * Absent otherwise; the loop then rebuilds the turn from `reply` and `toolCalls`.
   */
  assistantContent?: AssistantTurnBlock[];
  /**
   * True when the provider refused the conversation's replayed thinking and
   * the request was answered without it: the run stops replaying thinking.
   */
  thinkingDropped?: boolean;
  thinkingContent?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

/** Structured system prompt block for providers that support caching. */
export interface SystemContentBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' };
}

export interface ProviderChatOptions {
  tools?: ToolRow[];
  maxOutputTokens?: number;
  /** Structured system prompt blocks (used instead of agent.systemPrompt when provided). */
  systemBlocks?: SystemContentBlock[];
  /**
   * Anthropic prompt-cache TTL for the message-array breakpoints.
   * Defaults to '1h' in the provider when unset. Ignored by providers that
   * auto-cache.
   */
  cacheTtl?: '5m' | '1h';
  /** Called with each thinking text chunk as it streams. */
  onThinkingChunk?: OnThinkingChunkCallback;
  /**
   * Called with THIS call's usage-so-far while the response streams, so a
   * caller can surface a live token counter. Providers report what they
   * actually know and nothing more — see OnUsageCallback.
   */
  onUsage?: OnUsageCallback;
  /**
   * Called whenever the provider's response stream delivers any bytes: text,
   * thinking, tool-call argument deltas, pings, anything. Carries no data; it
   * exists so a caller's stream-idle watchdog can tell "slow but alive" (e.g.
   * a large tool input streaming, which fires none of the callbacks above)
   * from "hung". Fired by the shared stream readers.
   */
  onStreamActivity?: () => void;
  /** AbortSignal to cancel the streaming request. */
  signal?: AbortSignal;
  /** Thread ID for logging and observability. */
  threadId?: string;
}

/**
 * Cumulative usage for the CURRENT provider call, as known at the moment of
 * the callback. Every field is optional and absent until the provider has
 * actually reported it — a provider that learns nothing until the response
 * completes simply calls back once, at the end. Nothing here is ever
 * estimated: an absent field means "not reported", not "zero".
 */
export interface ProviderUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type OnChunkCallback = (chunk: string) => void;
export type OnThinkingChunkCallback = (chunk: string) => void;
export type OnUsageCallback = (usage: ProviderUsageSnapshot) => void;

export interface ProviderVerifyResult {
  valid: boolean;
  message: string;
}

export interface ProviderVerifyOptions {
  authType?: string;
  metadata?: Record<string, unknown>;
  credentialId?: string;
}
