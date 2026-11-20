import React, { useEffect, useRef, useState } from 'react';
import { FALLBACK_CREDENTIALS_FLAG } from '@snaglet/shared/types';
import { useFeatureFlag } from '@desktop/features/featureFlags/FeatureFlagsContext';
import { providersApi, type ProviderCredential, type ProviderAuthType } from '@desktop/utils/api';
import type { RetestState } from '../../types';
import { formatDate } from '../../utils';
import { Button, TextInput, Stack, Cluster } from '@desktop/components';
import styles from './CredentialRow.module.scss';

export type CredentialRotationRole = 'primary' | 'fallback' | 'other';

const VERIFICATION_LABEL: Record<ProviderCredential['verificationStatus'], string> = {
  untested: 'Not tested',
  ok: 'Verified',
  fail: 'Test failed',
};

interface CredentialRowProps {
  credential: ProviderCredential;
  authTypeLabel: string;
  authType?: ProviderAuthType;
  isPrimary: boolean;
  isFallback: boolean;
  fallbackIndex?: number;
  retestState?: RetestState;
  onChangeRotation?: (targetRole: CredentialRotationRole) => Promise<void> | void;
  onRetest: () => void;
  onDelete: () => void;
  onEdit?: (patch: { label?: string; secret?: string; metadata?: Record<string, unknown> }) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

export const CredentialRow: React.FC<CredentialRowProps> = ({
  credential,
  authTypeLabel,
  authType,
  isPrimary,
  isFallback,
  fallbackIndex,
  retestState,
  onChangeRotation,
  onRetest,
  onDelete,
  onEdit,
  draggable,
  onDragStart,
  onDragEnd,
}) => {
  // The Primary/Fallback badges, drag grip and Rotation buttons ship dark
  // (`fallback_credentials`, fails closed); the row is a plain key without them.
  const rotationUi = useFeatureFlag(FALLBACK_CREDENTIALS_FLAG);
  const isDraggable = rotationUi && draggable === true;
  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState(credential.label ?? '');
  const [editSecret, setEditSecret] = useState('');
  const [editMetadata, setEditMetadata] = useState<Record<string, string>>({});
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const [movingRole, setMovingRole] = useState<CredentialRotationRole | null>(null);
  // One pending "reset the copy status" timer at a time: a repeat copy replaces
  // it, and unmounting cancels it so it can't set state on a gone row.
  const copyResetTimerRef = useRef<number | null>(null);

  const clearCopyResetTimer = () => {
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
  };

  const scheduleCopyReset = (delayMs: number) => {
    clearCopyResetTimer();
    copyResetTimerRef.current = window.setTimeout(() => {
      copyResetTimerRef.current = null;
      setCopyStatus('idle');
    }, delayMs);
  };

  useEffect(() => clearCopyResetTimer, []);

  const isRetesting = retestState?.status === 'testing';
  const currentRole: CredentialRotationRole = isPrimary
    ? 'primary'
    : isFallback
      ? 'fallback'
      : 'other';

  const isMultiField = (authType?.metadataFields?.length ?? 0) > 0;

  const handleStartEdit = () => {
    setEditLabel(credential.label ?? '');
    setEditSecret('');
    setEditMetadata({});
    setEditing(true);
  };

  const handleSave = () => {
    if (!onEdit) return;
    const patch: { label?: string; secret?: string; metadata?: Record<string, unknown> } = {};
    const trimmedLabel = editLabel.trim();
    if (trimmedLabel && trimmedLabel !== credential.label) {
      patch.label = trimmedLabel;
    }
    if (editSecret.trim()) {
      patch.secret = editSecret.trim();
    }
    const hasMetadata = Object.values(editMetadata).some((v) => v.trim());
    if (hasMetadata) {
      patch.metadata = editMetadata;
    }
    if (Object.keys(patch).length > 0) {
      onEdit(patch);
    }
    setEditing(false);
  };

  const handleCancel = () => {
    setEditing(false);
  };

  const handleCopyCredential = async () => {
    clearCopyResetTimer();
    setCopyStatus('copying');
    try {
      const exported = await providersApi.exportCredential(credential.id);
      const value = JSON.stringify(exported, null, 2);
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard API is unavailable');
      }
      await navigator.clipboard.writeText(value);
      setCopyStatus('copied');
      scheduleCopyReset(1600);
    } catch {
      setCopyStatus('failed');
      scheduleCopyReset(2200);
    }
  };

  const handleRotationChange = async (targetRole: CredentialRotationRole) => {
    if (!onChangeRotation || targetRole === currentRole || movingRole) return;

    setMovingRole(targetRole);
    try {
      await onChangeRotation(targetRole);
    } finally {
      setMovingRole(null);
    }
  };

  if (editing) {
    return (
      <Stack gap={2} className={styles.editRow}>
        <div className={styles.editField}>
          <label className={styles.editLabel}>Label</label>
          <TextInput
            type="text"
            fullWidth
            value={editLabel}
            onChange={(e) => setEditLabel(e.target.value)}
            placeholder="Credential label"
            autoFocus
          />
        </div>

        {isMultiField ? (
          authType?.metadataFields?.map((field) => (
            <div key={field.key} className={styles.editField}>
              <label className={styles.editLabel}>{field.label}</label>
              <TextInput
                type={field.inputType ?? 'text'}
                fullWidth
                value={editMetadata[field.key] ?? ''}
                onChange={(e) =>
                  setEditMetadata((prev) => ({ ...prev, [field.key]: e.target.value }))
                }
                placeholder={
                  field.placeholder ?? `New ${field.label.toLowerCase()} (leave blank to keep)`
                }
              />
            </div>
          ))
        ) : (
          <div className={styles.editField}>
            <label className={styles.editLabel}>Secret</label>
            <TextInput
              type="password"
              fullWidth
              value={editSecret}
              onChange={(e) => setEditSecret(e.target.value)}
              placeholder="New key (leave blank to keep current)"
            />
          </div>
        )}

        <Cluster justify="end" gap={2}>
          <Button variant="ghost" size="md" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="md" onClick={handleSave}>
            Save
          </Button>
        </Cluster>
      </Stack>
    );
  }

  return (
    <div
      className={`${styles.row} ${isDraggable ? styles.draggable : styles.noGrip}`}
      data-credential-id={credential.id}
      draggable={isDraggable}
      onDragStart={isDraggable ? onDragStart : undefined}
      onDragEnd={isDraggable ? onDragEnd : undefined}
    >
      {isDraggable && (
        <span
          className={styles.grip}
          draggable
          aria-label={`Drag ${credential.label || 'credential'} to change its role`}
          title="Drag to Primary, Fallback, or Not in rotation"
          onDragStart={(event) => {
            event.stopPropagation();
            onDragStart?.(event);
          }}
          onDragEnd={(event) => {
            event.stopPropagation();
            onDragEnd?.(event);
          }}
        >
          ⠿
        </span>
      )}
      <div className={styles.info}>
        <div className={styles.label}>
          {rotationUi && isPrimary && <span className={styles.badgePrimary}>Primary</span>}
          {rotationUi && isFallback && fallbackIndex !== undefined && (
            <span className={styles.badgeFallback}>Fallback #{fallbackIndex + 1}</span>
          )}
          {credential.label || <span className={styles.labelFallback}>(unlabeled)</span>}
        </div>
        <div className={styles.meta}>
          {authTypeLabel} &middot; {formatDate(credential.updatedAt)} &middot;{' '}
          <span
            className={styles.status}
            data-status={credential.verificationStatus}
            title={
              credential.verificationStatus === 'untested'
                ? 'Saved without a remote check — use Retest to verify'
                : undefined
            }
          >
            <span className={styles.dot} data-status={credential.verificationStatus} aria-hidden />
            {VERIFICATION_LABEL[credential.verificationStatus] ?? credential.verificationStatus}
          </span>
        </div>
        {retestState?.message && retestState.status !== 'idle' && (
          <div
            className={
              retestState.status === 'ok'
                ? styles.retestOk
                : retestState.status === 'fail'
                  ? styles.retestFail
                  : styles.retestTesting
            }
          >
            {retestState.status === 'ok' && '✓ '}
            {retestState.status === 'fail' && '✗ '}
            {retestState.message}
          </div>
        )}
        {copyStatus === 'copied' && <div className={styles.copyOk}>Credential copied</div>}
        {copyStatus === 'failed' && <div className={styles.copyFail}>Copy failed</div>}
        {rotationUi && onChangeRotation && (
          <div
            className={styles.rotationControl}
            role="group"
            aria-label={`Rotation role for ${credential.label || 'credential'}`}
          >
            <span className={styles.rotationLabel}>Rotation</span>
            <div className={styles.rotationButtons}>
              {(
                [
                  ['primary', 'Make primary'],
                  ['fallback', 'Make fallback'],
                  ['other', 'Not in rotation'],
                ] as const
              ).map(([role, label]) => (
                <Button
                  key={role}
                  className={styles.rotationButton}
                  variant="neutral"
                  size="sm"
                  aria-pressed={currentRole === role}
                  disabled={movingRole !== null}
                  loading={movingRole === role}
                  loadingText="Moving…"
                  title={currentRole === role ? `${label} (current)` : label}
                  onClick={() => void handleRotationChange(role)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
      <Cluster justify="end" gap={1} className={styles.actions}>
        <Button
          variant="ghost"
          size="md"
          onClick={handleCopyCredential}
          loading={copyStatus === 'copying'}
          loadingText="Copying…"
          title="Copy credential JSON"
        >
          Copy
        </Button>
        {onEdit && (
          <Button variant="ghost" size="md" onClick={handleStartEdit}>
            Edit
          </Button>
        )}
        <Button
          variant="neutral"
          size="md"
          onClick={onRetest}
          loading={isRetesting}
          loadingText="Testing…"
        >
          Retest
        </Button>
        <Button variant="danger" size="md" onClick={onDelete}>
          Delete
        </Button>
      </Cluster>
    </div>
  );
};
