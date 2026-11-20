# Providers

Providers are the model services Snaglet's agents run on. This page lists the
providers Snaglet supports, how to connect each one, and how Snaglet keeps their
credentials safe.

## Supported providers

Open **Providers** in the activity bar, pick a provider and connect it.

| Provider        | How you connect                                                         |
| --------------- | ----------------------------------------------------------------------- |
| Anthropic       | **Sign in with Claude Code**, or an API key.                            |
| OpenAI          | API key.                                                                |
| OpenAI Codex    | Your local Codex CLI login, or an API key.                              |
| GitHub Copilot  | **Sign in with GitHub**, or a personal access token with Copilot scope. |
| Google Gemini   | Google AI Studio API key.                                               |
| Mistral AI      | API key.                                                                |
| Together AI     | API key.                                                                |
| DeepSeek        | API key.                                                                |
| xAI (Grok)      | API key.                                                                |
| Ollama          | No key. Runs locally at `http://127.0.0.1:11434/v1`.                    |
| LM Studio       | No key. Runs locally at `http://localhost:1234/v1`.                     |
| Apple On-Device | No key. Needs macOS 26+ with Apple Intelligence turned on.              |

Signing in with a Claude Code, OpenAI Codex or GitHub Copilot subscription
uses unofficial client paths that these providers do not document for other
apps. It uses your own subscription, and that use is subject to the provider's
terms.

The same view lists two integrations. **Google Workspace** connects a Google
account over OAuth, with an OAuth client you create, so agents can read and
change your Gmail, Calendar, Drive, Docs, Sheets and Forms. **GitHub** saves a
GitHub token that MCP servers you add can use: a server with the id `github`
reads it as `${credential}` in its environment variables or headers.

## Credentials and models

**Connect** saves a credential after checking its format. **Test** is
optional: it checks the credential against the provider, and a failed test
does not block saving. Token values are never shown in the UI.

Each provider has a primary credential. An agent uses it unless you pin the
agent to a specific credential. The first key you add becomes the primary.
Choosing a different primary, or marking other keys as fallbacks, needs the
`fallback_credentials` feature flag, which is off by default (see
[Feature flags](architecture.md#feature-flags)).

After you connect, import the provider's models, or add a custom model by
hand. Then pick a model for each agent in the **Agents** view.

## Sign in with Claude Code

Select **Anthropic** and press **Sign in with Claude Code**. Snaglet reads the
Claude Code CLI's own login from the macOS keychain. If there is none, Snaglet runs
`claude auth login`, which opens your browser, and waits for it to finish.
The Claude Code CLI must be installed.

Snaglet never writes to the keychain. The CLI refreshes its own token, and Snaglet
re-reads it when it needs one. If the login is revoked or expires, the button
changes to **Re-authenticate Claude Code**.

You can also paste a Claude Code OAuth token (`sk-ant-oat01-...`) under the
**Claude Code Pro** auth type. Snaglet does not refresh a pasted token.

## Codex CLI login

Run `codex login`, then select **OpenAI Codex** and press **Use local CLI
login**. Snaglet reads `~/.codex/auth.json` without changing it and stores the
access token, refresh token and account id as an encrypted credential. Snaglet uses
the refresh token to stay signed in.

## Sign in with GitHub

Select **GitHub Copilot** and press **Sign in with GitHub**, next to **+ Add key**.
Snaglet asks GitHub for a device code, shows it, and opens `github.com/login/device`
in your browser. Enter the code there and authorize. Once GitHub confirms, give
the login an optional label and press **Connect** to save it. The server
exchanges the GitHub token for a Copilot token when an agent needs one.

**+ Add key** takes a personal access token with Copilot scope instead.

## Credentials from the environment

In development, or with `SNAGLET_SEED_TEST_CREDENTIALS=1`, the server saves provider
keys it finds in the environment, such as `ANTHROPIC_API_KEY`, as credentials at
startup. `.env.example` lists them all.

## Encryption at rest

Snaglet encrypts every provider secret with AES-256-GCM before it reaches the
database, and decrypts it only inside the server. The key is
`CREDENTIAL_ENCRYPTION_KEY`, 64 hex characters. The server refuses to start
without a valid one.

- **Source checkout.** `pnpm dev` generates the key into `.env` on first run.
  Keep that file.
- **Packaged app.** The desktop shell creates a key once per install, saves it
  as `<SNAGLET_HOME>/credential.key`, and passes it to the server. It never replaces
  a missing or malformed key next to an existing database, because the saved
  credentials would become unreadable.

Back up `credential.key` together with the rest of your Snaglet home.

## Where the code lives

- `apps/server/src/utils/encryption.ts`: encrypt and decrypt.
- `apps/server/src/services/ProviderCredentialService/`: credential storage.
- `apps/server/src/services/ClaudeCodeAuthService/`: Claude Code sign-in.
- `apps/desktop/src-tauri/src/sidecar.rs`: the packaged app's key file.
