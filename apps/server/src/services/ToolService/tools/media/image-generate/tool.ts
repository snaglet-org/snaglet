/**
 * image_generate — text-to-image across every configured provider that
 * offers an image API: OpenAI (gpt-image-1, DALL-E 3 fallback), Gemini
 * (gemini-2.5-flash-image), Together (FLUX). Anthropic/Mistral/Copilot/
 * Ollama/LM Studio have no image-generation APIs and are not options.
 *
 * The result is persisted to the workspace images table (tagged
 * `tool-capture` + `generated` as provenance) and inlined into the
 * tool_result via the inlineImageIds
 * protocol: the agent sees what it generated on the same turn and can
 * iterate, instead of receiving a fire-and-forget URL.
 *
 * Placement: always the enclosing project's Images container, or root Images.
 * An explicit container_id selects project scope, not final placement.
 */

import {
  asNonEmptyString,
  generateId,
  getErrorMessage,
  requireString,
} from '@snaglet/shared/utils';
import { Images } from '@snaglet/db/tables/images';
import type { ImageListRow } from '@snaglet/db/tables/images';
import type { ToolHandler, ToolHandlerRichResult } from '@server/services/ToolService/types';
import { resolveOpenAISecret } from '@server/services/ToolService/handlers/_openai';
import { sniffImageMime } from '@server/services/ToolService/lib/sniffImageMime';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { resolveAgentImageContainer } from '@server/services/ToolService/lib/resolveAgentImageContainer';
import { emitTreeNodeCreated, snapshotFromImage } from '@server/realtime/surfaces/tree';

export type ImageProvider = 'openai' | 'gemini' | 'together';

/** Auto-pick order: best quality/ubiquity first. */
const PROVIDER_ORDER: ImageProvider[] = ['openai', 'gemini', 'together'];

// Vision models cap tool-result images at ~5 MB; larger results are still
// saved to the workspace, just not inlined.
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

interface GeneratedImage {
  buf: Buffer;
  model: string;
  revisedPrompt?: string;
}

async function resolveSecret(
  provider: ImageProvider,
  context: Parameters<ToolHandler>[2]
): Promise<string | null> {
  if (provider === 'openai') return resolveOpenAISecret(context);
  try {
    const stored = await providerCredentialService.getSecret(provider);
    if (stored) return stored;
  } catch {
    // fall through to env
  }
  if (provider === 'gemini') {
    return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? null;
  }
  return process.env.TOGETHER_API_KEY ?? null;
}

/** Map the DALL-E-style size enum onto what each backend actually accepts. */
export function mapSize(
  size: string,
  target: 'gpt-image-1' | 'dall-e-3' | 'flux'
): { size?: string; width?: number; height?: number } {
  const landscape = size === '1792x1024';
  const portrait = size === '1024x1792';
  if (target === 'gpt-image-1') {
    return { size: landscape ? '1536x1024' : portrait ? '1024x1536' : '1024x1024' };
  }
  if (target === 'dall-e-3') {
    return { size: landscape || portrait ? size : '1024x1024' };
  }
  // FLUX wants explicit dimensions (multiples of 16).
  if (landscape) return { width: 1792, height: 1024 };
  if (portrait) return { width: 1024, height: 1792 };
  const square = parseInt(size, 10);
  const dim = Number.isFinite(square) && square >= 256 ? Math.min(square, 1024) : 1024;
  return { width: dim, height: dim };
}

async function generateOpenAI(
  secret: string,
  prompt: string,
  size: string,
  style: string
): Promise<GeneratedImage> {
  const call = async (model: 'gpt-image-1' | 'dall-e-3') => {
    const body: Record<string, unknown> = { model, prompt, n: 1, ...mapSize(size, model) };
    if (model === 'dall-e-3') {
      body.style = style;
      body.response_format = 'b64_json';
    }
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`OpenAI ${model} failed (${res.status}): ${text}`), {
        status: res.status,
      });
    }
    const json = (await res.json()) as {
      data?: Array<{ b64_json?: string; revised_prompt?: string }>;
    };
    const result = json.data?.[0];
    if (!result?.b64_json) throw new Error(`OpenAI ${model} returned no image payload`);
    return {
      buf: Buffer.from(result.b64_json, 'base64'),
      model,
      revisedPrompt: result.revised_prompt,
    };
  };

  try {
    return await call('gpt-image-1');
  } catch (err) {
    // gpt-image-1 requires org verification on some accounts — fall back to
    // DALL-E 3 on access errors rather than failing the generation.
    const status = (err as { status?: number }).status;
    if (status === 403 || status === 404 || status === 400) {
      return call('dall-e-3');
    }
    throw err;
  }
}

async function generateGemini(secret: string, prompt: string): Promise<GeneratedImage> {
  const model = 'gemini-2.5-flash-image';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(secret)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini image generation failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    }>;
  };
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error('Gemini returned no image payload');
  return { buf: Buffer.from(part.inlineData.data, 'base64'), model };
}

async function generateTogether(
  secret: string,
  prompt: string,
  size: string
): Promise<GeneratedImage> {
  const model = 'black-forest-labs/FLUX.1-schnell';
  const res = await fetch('https://api.together.xyz/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      response_format: 'base64',
      ...mapSize(size, 'flux'),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Together image generation failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error('Together returned no image payload');
  return { buf: Buffer.from(b64, 'base64'), model };
}

const tool: ToolHandler = async (input, _settings, context): Promise<ToolHandlerRichResult> => {
  const prompt = requireString(input, 'prompt');
  const size = asNonEmptyString(input.size) ?? '1024x1024';
  const style = asNonEmptyString(input.style) ?? 'vivid';
  const requested = asNonEmptyString(input.provider) ?? 'auto';
  const explicitContainerId = asNonEmptyString(input.container_id);
  const containerId = await resolveAgentImageContainer(context?.threadId, explicitContainerId);

  // Resolve provider: explicit request must have a credential; auto takes
  // the first provider in order with one configured.
  let provider: ImageProvider | null = null;
  let secret: string | null = null;
  if (requested !== 'auto') {
    if (!PROVIDER_ORDER.includes(requested as ImageProvider)) {
      throw new Error(
        `image_generate: unknown provider "${requested}" — supported: auto, ${PROVIDER_ORDER.join(', ')}. ` +
          'Other providers (anthropic, mistral, ollama, …) have no image-generation API.'
      );
    }
    provider = requested as ImageProvider;
    secret = await resolveSecret(provider, context);
    if (!secret) {
      throw new Error(`image_generate: no credential configured for provider "${provider}".`);
    }
  } else {
    for (const candidate of PROVIDER_ORDER) {
      secret = await resolveSecret(candidate, context);
      if (secret) {
        provider = candidate;
        break;
      }
    }
    if (!provider || !secret) {
      throw new Error(
        `image_generate: no image-capable provider credential found (checked ${PROVIDER_ORDER.join(', ')}). ` +
          'Add an API key in Dashboard → Providers.'
      );
    }
  }

  const generated =
    provider === 'openai'
      ? await generateOpenAI(secret, prompt, size, style)
      : provider === 'gemini'
        ? await generateGemini(secret, prompt)
        : await generateTogether(secret, prompt, size);

  const mimeType = sniffImageMime(generated.buf) ?? 'image/png';
  const imageId = generateId('image');
  const name = `generated-${
    prompt
      .slice(0, 40)
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'image'
  }.${mimeType.split('/')[1]}`;
  let created: ImageListRow;
  try {
    created = await Images.createImage({
      id: imageId,
      name,
      containerId,
      description: `Generated by ${provider}/${generated.model}: ${prompt.slice(0, 500)}`,
      mimeType,
      data: generated.buf,
      sizeBytes: generated.buf.byteLength,
      // Provenance markers (agent-generated image); no auto-expiry.
      tags: ['tool-capture', 'generated'],
    });
  } catch (err) {
    throw new Error(
      `image_generate: generated the image but failed to save it: ${getErrorMessage(err)}`
    );
  }
  // Publish through the sanctioned surfaces/tree.ts chokepoint so a
  // container open in the UI picks up the new node live (same helper the
  // images REST route uses; `Images.createImage` itself does not emit).
  emitTreeNodeCreated(snapshotFromImage(created));

  const sizeKb = (generated.buf.byteLength / 1024).toFixed(1);
  const inline = generated.buf.byteLength <= MAX_INLINE_BYTES;
  const lines: string[] = [];
  lines.push(
    `Generated image saved as \`${imageId}\` (${provider}/${generated.model}, ${mimeType}, ${sizeKb} KB).`
  );
  if (generated.revisedPrompt && generated.revisedPrompt !== prompt) {
    lines.push(`Provider revised the prompt to: ${generated.revisedPrompt}`);
  }
  lines.push(`Filed in the Images container \`${containerId}\` (kept permanently).`);
  lines.push(
    `To show it to the user, include the marker <image id="${imageId}"/> in your reply.` +
      (inline
        ? ' The image bytes are attached inline to this tool result so you can inspect the output and regenerate if needed.'
        : ' (Too large to attach inline — use file(op:read, mode:image) with `id` set to this id to view it.)')
  );

  return {
    output: lines.join('\n'),
    rawContent: inline
      ? { inlineImageIds: [imageId], note: `generated image saved as ${imageId}` }
      : { note: `generated image saved as ${imageId} (too large to inline)` },
  };
};

export default tool;
