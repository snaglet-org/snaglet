/**
 * The ways to connect a model provider that the Get started pane offers, as
 * three groups of cards. Each card opens that provider's own connect panel
 * (the Providers view), so the credential logic stays in one place. A card
 * shows only when its provider is in the catalog.
 */
import type { Provider } from '@desktop/utils/api';
import type { ConnectVia } from '../ProvidersView/Providers/components/DetailPanel/DetailPanel';

export interface ProviderChoice {
  /** Unique within the pane; several cards can open one provider. */
  key: string;
  providerId: string;
  title: string;
  /** One line under the title. */
  blurb: string;
  /** Plain steps shown above the provider's connect panel; `text in backticks` shows as code. */
  help: (provider: Provider) => string;
  /** The Models section is needed to pick a local model; hosted ones import theirs. */
  showModels?: boolean;
  /**
   * Which ways to connect the panel offers. Claude Code and the Anthropic key
   * card open the same provider, so each offers only its own way in.
   */
  connectVia?: ConnectVia;
}

export interface ProviderChoiceGroup {
  id: 'subscription' | 'key' | 'local';
  label: string;
  /** A short line under the group's cards. */
  note?: string;
  choices: ProviderChoice[];
}

/** The key help the provider's catalog row carries ("Get your key at …"). */
function keyHelp(provider: Provider): string {
  const help = provider.authTypes.find((a) => a.type === 'api_key')?.tokenHelp?.trim();
  const where = help ? `${help} ` : '';
  return `${where}Then press + Add key, paste it, and press Connect. Snaglet tests it right away.`;
}

function keyChoice(providerId: string, title: string, blurb: string): ProviderChoice {
  return { key: `key-${providerId}`, providerId, title, blurb, help: keyHelp, connectVia: 'key' };
}

export const PROVIDER_CHOICE_GROUPS: readonly ProviderChoiceGroup[] = [
  {
    id: 'subscription',
    label: 'Use a subscription you already have',
    note: "These sign-ins use your own plan through paths the providers do not document for other apps; the provider's terms apply.",
    choices: [
      {
        key: 'claude-code',
        providerId: 'anthropic',
        title: 'Claude Code',
        blurb: 'Your Claude plan, through Claude Code',
        connectVia: 'sign-in',
        help: () =>
          'Needs the Claude Code command-line tool. Press Sign in with Claude Code. If you are not signed in yet, your browser opens so you can finish.',
      },
      {
        key: 'copilot',
        providerId: 'copilot',
        title: 'GitHub Copilot',
        blurb: 'Your Copilot plan',
        help: () =>
          'Press Sign in with GitHub. Snaglet shows a code and opens GitHub in your browser: enter the code there, then press Connect.',
      },
      {
        key: 'codex',
        providerId: 'codex',
        title: 'Codex',
        blurb: 'Your ChatGPT plan, through the Codex CLI',
        help: () =>
          'Run `codex login` in Terminal first. Then press Use local CLI login: Snaglet reads that login without changing it.',
      },
    ],
  },
  {
    id: 'key',
    label: 'Paste an API key',
    choices: [
      keyChoice('anthropic', 'Anthropic', 'Claude models'),
      keyChoice('openai', 'OpenAI', 'GPT models'),
      keyChoice('google', 'Google Gemini', 'Gemini models'),
      keyChoice('mistral', 'Mistral AI', 'Mistral models'),
      keyChoice('deepseek', 'DeepSeek', 'DeepSeek models'),
      keyChoice('xai', 'xAI', 'Grok models'),
      keyChoice('together', 'Together AI', 'Open models, hosted'),
    ],
  },
  {
    id: 'local',
    label: 'Run models on this Mac',
    note: 'Nothing leaves your computer. Local models are smaller, so agents may be slower or less capable.',
    choices: [
      {
        key: 'ollama',
        providerId: 'ollama',
        title: 'Ollama',
        blurb: 'Free app that runs open models',
        showModels: true,
        help: () =>
          'Install Ollama, start it and download a model. No key is needed: press Test connection, then Discover models and import the one you want.',
      },
      {
        key: 'lm-studio',
        providerId: 'lm-studio',
        title: 'LM Studio',
        blurb: 'Desktop app with a local server',
        showModels: true,
        help: (provider) =>
          `${provider.authTypes.find((a) => a.type === 'none')?.tokenHelp?.trim() ?? 'Start the LM Studio server with a model loaded.'} Then press Test connection, then Discover models and import the one you want.`,
      },
      {
        key: 'apple-on-device',
        providerId: 'apple-on-device',
        title: 'Apple On-Device',
        blurb: 'Built into macOS 26 with Apple Intelligence',
        help: () =>
          'Needs macOS 26 or later with Apple Intelligence turned on. No key is needed: when it is available, Snaglet connects it by itself and lists it under Connected.',
      },
    ],
  },
];
