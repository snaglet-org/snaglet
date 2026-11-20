import { asNonEmptyString, requireString } from '@snaglet/shared/utils';
import { writeFile } from 'fs/promises';
import type { ToolHandler } from '@server/services/ToolService/types';
import { requireOpenAISecret } from '@server/services/ToolService/handlers/_openai';
import { validatePathConstraint } from '@server/services/ToolService/handlers/_shared';

const tool: ToolHandler = async (input, settings, context) => {
  const text = requireString(input, 'text');
  const voice = asNonEmptyString(input.voice) ?? 'nova';
  const format = asNonEmptyString(input.format) ?? 'mp3';
  const speed = Number(input.speed ?? 1);
  const outputPath = asNonEmptyString(input.outputPath);
  const secret = await requireOpenAISecret(context);

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice,
      response_format: format,
      speed,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI text-to-speech failed (${response.status}): ${body}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (outputPath) {
    validatePathConstraint(outputPath, settings);
    await writeFile(outputPath, audio);
    return `Audio saved to ${outputPath}`;
  }

  return JSON.stringify(
    {
      format,
      base64: audio.toString('base64'),
    },
    null,
    2
  );
};

export default tool;
