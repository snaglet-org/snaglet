import type { FC } from 'react';
import type { McpConnectInfo } from '@snaglet/shared/types';
import { CopyToClipboardButton } from '@desktop/components';
import { MCP_KEY_PLACEHOLDER, mcpConnectSnippets } from './mcpConnectSnippets';
import styles from './McpConnections.module.scss';

interface SnippetProps {
  label: string;
  hint?: string;
  value: string;
  onCopyError: () => void;
}

const Snippet: FC<SnippetProps> = ({ label, hint, value, onCopyError }) => (
  <div className={styles.snippet}>
    <div className={styles.snippetHeader}>
      <span className={styles.snippetLabel}>{label}</span>
      <CopyToClipboardButton
        className={styles.copyButton}
        value={value}
        aria-label={`Copy ${label}`}
        idleContent="Copy"
        copiedContent="Copied"
        onCopyError={onCopyError}
      />
    </div>
    {hint && <div className={styles.snippetHint}>{hint}</div>}
    <pre className={styles.snippetValue}>
      <code>{value}</code>
    </pre>
  </div>
);

interface McpConnectSetupProps {
  info: McpConnectInfo;
  /** The key, only in the one-time view right after it was minted; null otherwise. */
  token: string | null;
  onCopyError: () => void;
}

/**
 * Ready-to-paste setup for this client: the Claude Code
 * command, the JSON config other MCP clients read, and the HTTP URL and
 * header, each with Copy. The key is filled in only while it is shown once;
 * otherwise the snippets carry a placeholder.
 */
export const McpConnectSetup: FC<McpConnectSetupProps> = ({ info, token, onCopyError }) => {
  const snippets = mcpConnectSnippets(info, token);
  return (
    <div className={styles.connect}>
      <p className={styles.connectLine}>
        This key is for the <strong>{info.profile === 'dev' ? 'dev' : 'production'} Snaglet</strong>{' '}
        at <code>{info.snagletHome}</code>. It does not work with any other Snaglet.
      </p>
      {!token && (
        <p className={styles.connectNotice}>
          The key was shown only once, when this connection was created, so the setup below has{' '}
          <code>{MCP_KEY_PLACEHOLDER}</code> in its place. If the key was lost, create a new
          connection and revoke this one.
        </p>
      )}
      {snippets.needsCli && (
        <p className={styles.connectNotice}>
          No <code>snaglet</code> command for this Snaglet was found. Put <code>snaglet</code> on
          your PATH.
        </p>
      )}
      <Snippet
        label="Claude Code command"
        hint="Run it in a terminal."
        value={snippets.claudeCode}
        onCopyError={onCopyError}
      />
      <Snippet
        label="MCP JSON config"
        hint="For Claude Desktop, Cursor and other clients: add it to their MCP config."
        value={snippets.jsonConfig}
        onCopyError={onCopyError}
      />
      <Snippet
        label="HTTP URL"
        hint="The port changes every time the Snaglet app starts, so prefer the snaglet mcp setup above, which follows the app."
        value={snippets.httpUrl}
        onCopyError={onCopyError}
      />
      <Snippet
        label="HTTP header"
        hint="HTTP clients send this header with every request."
        value={snippets.httpHeader}
        onCopyError={onCopyError}
      />
    </div>
  );
};
