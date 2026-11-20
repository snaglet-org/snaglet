import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import {
  SHELL_BACKGROUND_MAX_MS,
  SHELL_HARD_TIMEOUT_MS,
  SHELL_MAX_BACKGROUND_JOBS_PER_AGENT,
  SHELL_MAX_TIMEOUT_MS,
  formatShellDuration as fmt,
} from '../shellGuardrails';

// The env defaults at boot. The `tool.shell` setting can change them at
// runtime; a call over the maximum is clamped and its result says so.
const DEFAULT_MS = Math.min(SHELL_HARD_TIMEOUT_MS, SHELL_MAX_TIMEOUT_MS);

const definition: BuiltinToolDefinition = {
  id: 'shell',
  name: 'Shell',
  description:
    'Run shell commands on the host. op: run executes cmd; if it is still running after yield_time_ms you get a session_id. background: true returns at once and messages you the result when it exits. op: write sends chars to the stdin of a session started by run, or polls for more output when chars is omitted. Pipe-backed, not a TTY: full-screen or interactive programs (editors, pagers, `git … -p`) are not supported, so pass non-interactive flags.',
  type: 'builtin',
  tier: 'core',
  keywords: ['shell', 'exec', 'run', 'command', 'terminal', 'bash', 'cli', 'stdin', 'session'],
  aliases: ['terminal', 'bash'],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    properties: {
      op: { type: 'string', enum: ['run', 'write'] },
      cmd: { type: 'string', description: 'run: the command.' },
      workdir: {
        type: 'string',
        description: 'run: working directory. Defaults to the project folder.',
      },
      timeout_ms: {
        type: 'integer',
        description: `run: kill the command after this long. Default ${fmt(DEFAULT_MS)}, max ${fmt(SHELL_MAX_TIMEOUT_MS)}; background: default and max ${fmt(SHELL_BACKGROUND_MAX_MS)}.`,
      },
      background: {
        type: 'boolean',
        description: `run: for tests, builds, servers you'll check on later. Max ${SHELL_MAX_BACKGROUND_JOBS_PER_AGENT} running at once.`,
      },
      session_id: { type: 'integer', description: 'write: session id returned by run.' },
      chars: { type: 'string', description: 'write: text to send to stdin. Omit to poll.' },
      yield_time_ms: {
        type: 'integer',
        description:
          'How long to wait for output before returning (run default 10000, write 1000).',
      },
      max_output_tokens: {
        type: 'integer',
        default: 10000,
        description: 'Approximate cap on returned output (~4 chars/token).',
      },
      shell: { type: 'string', description: 'run: shell binary. Defaults to the platform shell.' },
    },
  },
  sort_order: 20,
};

export default definition;
