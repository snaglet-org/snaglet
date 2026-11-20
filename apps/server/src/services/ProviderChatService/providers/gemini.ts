import type { SnagletAgent } from '@server/services/AgentService';
import { toGeminiTools } from '@server/services/ToolService';
import { logger } from '@server/config/logger';
import { elapsedMs } from '@snaglet/shared/utils';
import { assertSecret, logProviderPayload, pickSecret } from '../shared';
import { readSSEJsonEvents } from './shared/sse';
import type {
  OnChunkCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
  ProviderVerifyResult,
  ToolCall,
  ToolResultBlock,
  ToolUseBlock,
} from '../types';
import { splitToolResultContent } from '../types';

export async function chatGemini(
  agent: SnagletAgent,
  messages: ProviderMessage[],
  onChunk?: OnChunkCallback,
  options?: ProviderChatOptions
): Promise<ProviderChatResult> {
  const secret = await pickSecret(agent);
  assertSecret(secret, agent.provider);

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(agent.modelId ?? '')}` +
    `:streamGenerateContent?alt=sse&key=${encodeURIComponent(secret)}`;

  const contents: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      contents.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      });
    } else if (Array.isArray(message.content)) {
      if (message.role === 'user') {
        const blocks = message.content as unknown as Array<Record<string, unknown>>;
        const isToolResult = blocks.some((b) => b.type === 'tool_result');
        if (isToolResult) {
          const parts: Record<string, unknown>[] = [];
          const followupImageParts: Record<string, unknown>[] = [];
          for (const block of message.content) {
            if ((block as ToolResultBlock).type === 'tool_result') {
              const toolResult = block as ToolResultBlock;
              const { text, images } = splitToolResultContent(toolResult.content);
              parts.push({
                functionResponse: {
                  name: toolResult.tool_use_id,
                  // Gemini's functionResponse body is text-only; images follow
                  // as a separate user turn below.
                  response: { content: text || '[tool result]' },
                },
              });
              for (const img of images) {
                if (img.source.type === 'base64') {
                  followupImageParts.push({
                    inline_data: { mime_type: img.source.media_type, data: img.source.data },
                  });
                } else {
                  followupImageParts.push({
                    file_data: { mime_type: 'image/*', file_uri: img.source.url },
                  });
                }
              }
            }
          }
          if (parts.length > 0) contents.push({ role: 'user', parts });
          if (followupImageParts.length > 0) {
            contents.push({ role: 'user', parts: followupImageParts });
          }
          continue;
        }
        // Multimodal: map text + image blocks to Gemini parts
        const parts: Record<string, unknown>[] = [];
        for (const b of blocks) {
          if (b.type === 'text' && typeof b.text === 'string') {
            parts.push({ text: b.text });
          } else if (b.type === 'image') {
            const src = b.source as
              | { type: 'base64'; media_type: string; data: string }
              | { type: 'url'; url: string }
              | undefined;
            if (src?.type === 'base64') {
              parts.push({
                inline_data: { mime_type: src.media_type, data: src.data },
              });
            } else if (src?.type === 'url') {
              parts.push({
                file_data: { mime_type: 'image/*', file_uri: src.url },
              });
            }
          }
        }
        if (parts.length > 0) contents.push({ role: 'user', parts });
      } else if (message.role === 'assistant') {
        const parts: Record<string, unknown>[] = [];
        for (const block of message.content) {
          if ((block as { type: string }).type === 'text') {
            parts.push({ text: (block as { text: string }).text });
          } else if ((block as ToolUseBlock).type === 'tool_use') {
            const toolUse = block as ToolUseBlock;
            parts.push({ functionCall: { name: toolUse.name, args: toolUse.input } });
          }
        }
        contents.push({ role: 'model', parts });
      }
    }
  }

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: agent.systemPrompt }] },
    contents,
  };

  if (options?.maxOutputTokens) {
    body.generationConfig = { maxOutputTokens: options.maxOutputTokens };
  }

  if (options?.tools && options.tools.length > 0) {
    body.tools = [toGeminiTools(options.tools)];
  }

  logProviderPayload('gemini', agent, body, {
    'Content-Type': 'application/json',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      (data.error as { message?: string } | undefined)?.message ??
      `Gemini request failed (${res.status})`;
    throw new Error(message);
  }

  if (!res.body) throw new Error('Gemini returned no response body');

  let reply = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  const toolCalls: ToolCall[] = [];
  const requestStartedAt = Date.now();
  let finishReason = '';

  for await (const ev of readSSEJsonEvents(res.body, options?.onStreamActivity)) {
    const candidates = ev.candidates as Array<Record<string, unknown>> | undefined;
    const content = candidates?.[0]?.content as
      | {
          parts?: Array<{
            text?: string;
            functionCall?: { name: string; args: Record<string, unknown> };
          }>;
        }
      | undefined;

    const finish = candidates?.[0]?.finishReason;
    if (typeof finish === 'string' && finish) finishReason = finish;

    for (const part of content?.parts ?? []) {
      if (part.text) {
        reply += part.text;
        onChunk?.(part.text);
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `gemini-${Date.now()}-${toolCalls.length}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        });
      }
    }

    // Gemini restates cumulative `usageMetadata` on the chunks it attaches it
    // to, so this can fire several times per call — the caller coalesces.
    const usage = ev.usageMetadata as Record<string, unknown> | undefined;
    if (usage) {
      inputTokens = Number(usage.promptTokenCount ?? 0) || undefined;
      outputTokens = Number(usage.candidatesTokenCount ?? 0) || undefined;
      // Implicit-caching hits land in `cachedContentTokenCount` — a SUBSET of
      // `promptTokenCount`, unlike Anthropic where fresh/read/write are
      // disjoint. Gemini reports cache READS only; there is no
      // creation/write count in the API, so cache_creation below is always 0.
      cacheReadTokens = Number(usage.cachedContentTokenCount ?? 0) || undefined;
      options?.onUsage?.({ inputTokens, outputTokens });
    }
  }

  // Same line shape as the anthropic provider so log tooling parses both.
  // `input=` is fresh-only there, so subtract cached reads here to match.
  {
    const totalIn = inputTokens ?? 0;
    const read = cacheReadTokens ?? 0;
    const fresh = Math.max(0, totalIn - read);
    const hitPct = totalIn > 0 ? Math.round((read / totalIn) * 100) : 0;
    const escapedAgentName = (agent.name ?? '').replace(/\s+/g, '_');
    logger.info(
      `[cache_metrics] pid=${process.pid} thread_id=${options?.threadId || 'unknown'} ` +
        `agent_id=${agent.id} agent_name=${escapedAgentName} ` +
        `model=${agent.modelId} input=${fresh} cache_read=${read} ` +
        `cache_creation=0 output=${outputTokens ?? 0} ` +
        `hit_ratio=${(hitPct / 100).toFixed(3)} latency_ms=${elapsedMs(requestStartedAt)}`
    );
  }

  return {
    reply,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    // MAX_TOKENS: the output limit cut the reply off, and a function call in
    // it may be truncated, so it is not a tool turn.
    stopReason:
      finishReason === 'MAX_TOKENS' ? 'max_tokens' : toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    // `inputTokens` (promptTokenCount) already INCLUDES cached reads —
    // no roll-up needed here, unlike anthropic.
    usage: { inputTokens, outputTokens, cacheReadTokens },
  };
}

export async function verifyGemini(secret: string): Promise<ProviderVerifyResult> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(secret)}`
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      (data.error as { message?: string } | undefined)?.message ??
      `Authentication failed (${res.status})`;
    return { valid: false, message };
  }
  return { valid: true, message: 'Connected successfully' };
}
