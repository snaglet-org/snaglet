import { useState, type FC } from 'react';
import { Modal, Button, TextInput, Textarea, Select, Switch } from '@desktop/components';
import type { McpServer, McpServerUpsert, McpTransport, McpScope } from '@desktop/utils/api';
import styles from './McpView.module.scss';

interface ServerEditorProps {
  /** Editing an existing server, or undefined to add a new one. */
  initial?: McpServer;
  busy: boolean;
  onClose: () => void;
  onSave: (data: McpServerUpsert) => Promise<boolean>;
  error?: string | null;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function linesToArray(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function arrayToLines(arr: string[]): string {
  return (arr ?? []).join('\n');
}

/** Parse a "KEY=VALUE" block (one per line) into an object. */
function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key) out[key] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function keyValuesToText(map: Record<string, string>): string {
  return Object.entries(map ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/**
 * Add/edit form for an MCP server connection spec. Credentials are managed
 * separately (per-server, derived from env/headers placeholders) — this form
 * only edits the connection config. Reference a credential by writing
 * `${credential}` (one opaque secret) or `${cred.fieldName}` in env/headers.
 */
export const ServerEditor: FC<ServerEditorProps> = ({ initial, busy, onClose, onSave, error }) => {
  const editing = Boolean(initial);
  const [id, setId] = useState(initial?.id ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? 'stdio');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [argsText, setArgsText] = useState(arrayToLines(initial?.args ?? []));
  const [url, setUrl] = useState(initial?.url ?? '');
  const [envText, setEnvText] = useState(keyValuesToText(initial?.env ?? {}));
  const [headersText, setHeadersText] = useState(keyValuesToText(initial?.headers ?? {}));
  const [scope, setScope] = useState<McpScope>(initial?.scope ?? 'shared');
  const [requiresConfirmation, setRequiresConfirmation] = useState(
    initial?.requiresConfirmation ?? true
  );
  const [localError, setLocalError] = useState<string | null>(null);

  const isStdio = transport === 'stdio';

  const handleSave = async () => {
    setLocalError(null);
    const trimmedId = id.trim();
    if (!ID_RE.test(trimmedId)) {
      setLocalError("Id must be lowercase letters, digits, '-' or '_' (e.g. my-server).");
      return;
    }
    if (!name.trim()) {
      setLocalError('Name is required.');
      return;
    }
    if (isStdio && !command.trim()) {
      setLocalError('stdio servers require a command (e.g. npx).');
      return;
    }
    if (!isStdio && !url.trim()) {
      setLocalError(`${transport} servers require a URL.`);
      return;
    }
    const data: McpServerUpsert = {
      id: trimmedId,
      name: name.trim(),
      transport,
      command: isStdio ? command.trim() : null,
      args: isStdio ? linesToArray(argsText) : [],
      url: isStdio ? null : url.trim(),
      env: parseKeyValues(envText),
      headers: isStdio ? {} : parseKeyValues(headersText),
      scope,
      requiresConfirmation,
    };
    const ok = await onSave(data);
    if (ok) onClose();
  };

  return (
    <Modal onClose={onClose}>
      <Modal.Header>
        <h2 className={styles.modalTitle}>
          {editing ? `Edit ${initial?.name}` : 'Add MCP server'}
        </h2>
      </Modal.Header>
      <Modal.Body>
        <div className={styles.form}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Id</span>
            <TextInput
              fullWidth
              value={id}
              disabled={editing}
              placeholder="my-server"
              onChange={(e) => setId(e.target.value)}
            />
            <span className={styles.fieldHint}>
              Stable slug; also the credential key for custom servers.
            </span>
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Name</span>
            <TextInput
              fullWidth
              value={name}
              placeholder="My Server"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Transport</span>
            <Select
              value={transport}
              onChange={(e) => setTransport(e.target.value as McpTransport)}
            >
              <option value="stdio">stdio (local subprocess)</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </Select>
            {!isStdio && (
              <span className={styles.fieldHint}>
                Note: http/sse transports are not connectable yet — config is stored for later.
              </span>
            )}
          </label>

          {isStdio ? (
            <>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Command</span>
                <TextInput
                  fullWidth
                  value={command}
                  placeholder="npx"
                  onChange={(e) => setCommand(e.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Args (one per line)</span>
                <Textarea
                  value={argsText}
                  rows={3}
                  placeholder={'-y\n@scope/my-mcp-server'}
                  onChange={(e) => setArgsText(e.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>URL</span>
                <TextInput
                  fullWidth
                  value={url}
                  placeholder="https://example.com/mcp"
                  onChange={(e) => setUrl(e.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Headers (KEY=VALUE per line)</span>
                <Textarea
                  value={headersText}
                  rows={3}
                  placeholder={'Authorization=Bearer ${credential}'}
                  onChange={(e) => setHeadersText(e.target.value)}
                />
              </label>
            </>
          )}

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Env (KEY=VALUE per line)</span>
            <Textarea
              value={envText}
              rows={3}
              placeholder={'MY_TOKEN=${credential}'}
              onChange={(e) => setEnvText(e.target.value)}
            />
            <span className={styles.fieldHint}>
              Use <code>{'${credential}'}</code> for a single secret or{' '}
              <code>{'${cred.fieldName}'}</code> for named fields — set the values in the credential
              section after saving.
            </span>
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Scope</span>
            <Select value={scope} onChange={(e) => setScope(e.target.value as McpScope)}>
              <option value="shared">shared (one connection for all agents)</option>
              <option value="per-agent">per-agent (isolated subprocess per agent)</option>
            </Select>
          </label>

          <label className={styles.switchRow}>
            <Switch checked={requiresConfirmation} onChange={(v) => setRequiresConfirmation(v)} />
            <span className={styles.fieldLabel}>Require confirmation before each tool call</span>
          </label>

          {(localError ?? error) && (
            <div className={styles.errorBanner} role="alert">
              {localError ?? error}
            </div>
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} loadingText="Saving…" onClick={handleSave}>
          {editing ? 'Save changes' : 'Add server'}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
