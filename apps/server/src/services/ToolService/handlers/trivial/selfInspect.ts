import type { ToolHandler } from '@server/services/ToolService/types';

const tool: ToolHandler = async (_input, _settings, context) => {
  const rt = context?.runtime;
  const lines: string[] = [
    '## Runtime Configuration',
    '',
    `Agent ID: ${context?.agentId ?? 'unknown'}`,
    `Agent Name: ${rt?.agentName ?? 'unknown'}`,
    `Thread ID: ${context?.threadId ?? 'unknown'}`,
    '',
    '### Model',
    `Provider: ${rt?.provider ?? 'unknown'}`,
    `Model: ${rt?.modelId ?? 'unknown'}`,
    `Credential ID: ${rt?.credentialId ?? 'none'}`,
  ];
  return lines.join('\n');
};

export default tool;
