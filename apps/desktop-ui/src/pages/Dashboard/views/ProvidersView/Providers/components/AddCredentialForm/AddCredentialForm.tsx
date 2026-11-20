import { type FC, useId, useRef } from 'react';
import type { Provider, MetadataField, ProviderAuthType } from '@desktop/utils/api';
import type { CredentialDraft, VerifyState } from '../../types';
import { Button } from '@desktop/components';
import { CopilotDeviceFlow } from '../CopilotDeviceFlow/CopilotDeviceFlow';
import { GoogleOAuthFlow } from '../GoogleOAuthFlow/GoogleOAuthFlow';
import styles from './AddCredentialForm.module.scss';

interface AddCredentialFormProps {
  provider: Provider;
  draft: CredentialDraft;
  selectedAuthType: ProviderAuthType | undefined;
  /**
   * Auth types the switcher offers; defaults to all of the provider's. GitHub
   * Copilot's Add key form leaves out the OAuth type, which has its own
   * Sign in with GitHub button.
   */
  authTypes?: ProviderAuthType[];
  /**
   * Render the GitHub device flow (Sign in with GitHub) instead of the key
   * form. The flow starts on mount and saves its token under
   * `selectedAuthType`.
   */
  githubSignIn?: boolean;
  multiField: boolean;
  verify: VerifyState;
  isTesting: boolean;
  isSaving: boolean;
  error?: string | null;
  onPatchDraft: (patch: Partial<CredentialDraft>) => void;
  onApplyJsonPaste: (fields: MetadataField[], json: string) => void;
  onTest: () => void;
  onSave: () => void;
  onGoogleConnected?: (credentialId: string) => void;
}

export const AddCredentialForm: FC<AddCredentialFormProps> = ({
  provider,
  draft,
  selectedAuthType,
  authTypes = provider.authTypes,
  githubSignIn = false,
  multiField,
  verify,
  isTesting,
  isSaving,
  error,
  onPatchDraft,
  onApplyJsonPaste,
  onTest,
  onSave,
  onGoogleConnected,
}) => {
  const isRedirectOAuth = draft.authTypeId === 'google-workspace:oauth';
  const hasMultiAuth = authTypes.length > 1;
  const labelId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const verifyBorderClass =
    verify.status === 'ok' ? styles.borderOk : verify.status === 'fail' ? styles.borderFail : '';

  // Parse as the user pastes so Connect saves the parsed fields; the raw text
  // alone never reaches `metadata`. An emptied box is not an error.
  const handleJsonPasteChange = (json: string) => {
    if (!json.trim()) {
      onPatchDraft({ jsonPaste: json, jsonError: null });
      return;
    }
    onApplyJsonPaste(selectedAuthType?.metadataFields ?? [], json);
  };

  /* Special flows */
  if (isRedirectOAuth) {
    return (
      <GoogleOAuthFlow
        onConnected={(credId, _email) => {
          if (onGoogleConnected) onGoogleConnected(credId);
          else onSave();
        }}
        onCancel={() =>
          onPatchDraft({
            authTypeId: provider.authTypes[0]?.id ?? '',
            pasteMode: false,
            jsonPaste: '',
            jsonError: null,
            metadata: {},
          })
        }
      />
    );
  }

  if (githubSignIn) {
    return (
      <div className={styles.shell}>
        <CopilotDeviceFlow
          completionMode="explicit-save"
          autoStart
          // The token always lands on the device-flow auth type, even if the
          // draft was reset to the Add key default after an earlier save.
          onToken={(token) =>
            onPatchDraft({ authTypeId: selectedAuthType?.id ?? draft.authTypeId, secret: token })
          }
        />

        <div className={styles.labelRow}>
          <label className={styles.labelText} htmlFor={labelId}>
            Label <span className={styles.opt}>optional</span>
          </label>
          <input
            id={labelId}
            className={styles.labelInput}
            type="text"
            value={draft.label}
            placeholder="e.g. Personal, Work, Shared…"
            onChange={(e) => onPatchDraft({ label: e.target.value })}
          />
        </div>

        {error && <p className={`${styles.verifyMsg} ${styles.fail}`}>{error}</p>}

        <div className={styles.footer}>
          <div className={styles.footerLeft} />
          <div className={styles.footerRight}>
            <Button
              variant="primary"
              size="md"
              onClick={onSave}
              disabled={isSaving || !draft.secret || provider.authTypes.length === 0}
              loading={isSaving}
              loadingText="Connecting…"
            >
              Connect
            </Button>
          </div>
        </div>
      </div>
    );
  }

  /* Standard form */
  return (
    <div className={styles.shell}>
      {/* Auth-type toggle (only when multiple exist) */}
      {hasMultiAuth && (
        <div className={styles.authSegment} role="group" aria-label="Auth type">
          {authTypes.map((authType) => (
            <button
              key={authType.id}
              role="radio"
              aria-checked={draft.authTypeId === authType.id}
              className={`${styles.authBtn} ${draft.authTypeId === authType.id ? styles.authBtnOn : ''}`}
              onClick={() =>
                onPatchDraft({
                  authTypeId: authType.id,
                  pasteMode: false,
                  jsonPaste: '',
                  jsonError: null,
                  metadata: {},
                })
              }
            >
              {authType.name}
            </button>
          ))}
        </div>
      )}

      {/* Key entry area */}
      <div className={`${styles.keyWrap} ${verifyBorderClass}`}>
        {/* Single secret input */}
        {!multiField && !draft.pasteMode && (
          <input
            ref={inputRef}
            className={styles.keyInput}
            type="password"
            value={draft.secret}
            placeholder={selectedAuthType?.tokenPlaceholder ?? 'sk-…'}
            onChange={(e) => onPatchDraft({ secret: e.target.value })}
            autoComplete="off"
            autoFocus
          />
        )}

        {/* Multi-field — individual rows */}
        {multiField && !draft.pasteMode && (
          <div className={styles.multiRows}>
            {selectedAuthType?.metadataFields?.map((field) => (
              <div key={field.key} className={styles.multiRow}>
                <span className={styles.fieldLabel}>{field.label}</span>
                <input
                  className={styles.fieldInput}
                  type={field.inputType}
                  value={draft.metadata[field.key] ?? ''}
                  placeholder={field.placeholder ?? field.label}
                  onChange={(e) =>
                    onPatchDraft({ metadata: { ...draft.metadata, [field.key]: e.target.value } })
                  }
                  autoComplete="off"
                />
              </div>
            ))}
          </div>
        )}

        {/* Paste JSON */}
        {draft.pasteMode && (
          <textarea
            aria-label="Credential JSON"
            className={styles.pasteArea}
            value={draft.jsonPaste}
            placeholder={`Paste JSON — e.g. ${JSON.stringify(
              Object.fromEntries((selectedAuthType?.metadataFields ?? []).map((f) => [f.key, '']))
            )}`}
            onChange={(e) => handleJsonPasteChange(e.target.value)}
            rows={(selectedAuthType?.metadataFields?.length ?? 1) + 2}
            spellCheck={false}
            autoFocus
          />
        )}

        {/* Verify status strip */}
        {verify.status !== 'idle' && verify.message && (
          <p role="status" className={`${styles.verifyMsg} ${styles[verify.status]}`}>
            {verify.status === 'ok' && '✓ '}
            {verify.status === 'fail' && '✗ '}
            {verify.message}
          </p>
        )}
        {draft.jsonError && (
          <p className={`${styles.verifyMsg} ${styles.fail}`}>{draft.jsonError}</p>
        )}
        {!draft.jsonError && error && (
          <p className={`${styles.verifyMsg} ${styles.fail}`}>{error}</p>
        )}
        {!draft.jsonError &&
          draft.pasteMode &&
          draft.jsonPaste.trim() !== '' &&
          Object.keys(draft.metadata).length > 0 && (
            <p className={`${styles.verifyMsg} ${styles.ok}`}>✓ Parsed</p>
          )}
      </div>

      {/* Hint text */}
      {selectedAuthType?.tokenHelp && !multiField && (
        <p className={styles.hint}>{selectedAuthType.tokenHelp}</p>
      )}
      <p className={styles.hint}>
        Test is optional — Connect saves the key as untested; Retest it any time.
      </p>

      {/* Label row */}
      <div className={styles.labelRow}>
        <label className={styles.labelText} htmlFor={labelId}>
          Label <span className={styles.opt}>optional</span>
        </label>
        <input
          id={labelId}
          className={styles.labelInput}
          type="text"
          value={draft.label}
          placeholder="e.g. Personal, Work, Shared…"
          onChange={(e) => onPatchDraft({ label: e.target.value })}
        />
      </div>

      {/* Footer actions */}
      <div className={styles.footer}>
        <div className={styles.footerLeft}>
          {multiField && (
            <button
              className={styles.chip}
              onClick={() => onPatchDraft({ pasteMode: !draft.pasteMode, jsonError: null })}
            >
              {draft.pasteMode ? '⌨ Enter fields' : '{ } Paste JSON'}
            </button>
          )}
        </div>

        <div className={styles.footerRight}>
          <button
            className={styles.testBtn}
            onClick={onTest}
            disabled={isSaving || isTesting || provider.authTypes.length === 0}
          >
            {isTesting ? 'Testing…' : 'Test'}
          </button>

          <Button
            variant="primary"
            size="md"
            onClick={onSave}
            disabled={isTesting || provider.authTypes.length === 0}
            loading={isSaving}
            loadingText="Connecting…"
          >
            Connect
          </Button>
        </div>
      </div>
    </div>
  );
};
