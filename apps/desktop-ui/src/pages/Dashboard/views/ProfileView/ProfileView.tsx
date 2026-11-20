import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { userProfileApi, type UserProfile, type UserOption } from '@desktop/utils/api';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import { Button, Modal, Select, TextInput } from '@desktop/components';
import styles from './ProfileView.module.scss';
import { getErrorMessage } from '@snaglet/shared/utils';
import { getActiveUserId, setActiveUserId } from '@desktop/config';

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (profile: UserProfile, makeActive: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [makeActive, setMakeActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const submit = useCallback(async () => {
    if (saving) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await userProfileApi.createUser({
        name: trimmedName,
        email: email.trim() || undefined,
        makeActive,
      });
      onCreated(created, makeActive);
    } catch (err) {
      setError(getErrorMessage(err, 'Create user failed'));
    } finally {
      setSaving(false);
    }
  }, [email, makeActive, name, onCreated, saving]);

  return (
    <Modal onClose={saving ? () => undefined : onClose}>
      <Modal.Header>Create user</Modal.Header>
      <Modal.Body>
        <div className={styles.modalFields}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="profile-create-name">
              Name
            </label>
            <TextInput
              ref={nameRef}
              id="profile-create-name"
              type="text"
              fullWidth
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={saving}
              placeholder="User name"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="profile-create-email">
              Email (optional)
            </label>
            <TextInput
              id="profile-create-email"
              type="email"
              fullWidth
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={saving}
              placeholder="user@example.com"
            />
          </div>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={makeActive}
              onChange={(event) => setMakeActive(event.target.checked)}
              disabled={saving}
            />
            Make active on this device
          </label>
          {error && (
            <div className={styles.errorBanner} role="alert">
              {error}
            </div>
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="neutral" size="md" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={() => void submit()}
          disabled={!name.trim()}
          loading={saving}
          loadingText="Creating…"
        >
          Create user
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/**
 * ProfileView — editable profile and local user picker, opened from the Profile
 * tab in the activity bar. Creating users is local-only; OAuth/provider/model
 * setup remains in Providers and Agents.
 */
export const ProfileView: FC = () => {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [activeUserId, setActiveUserIdState] = useState<string>(() => getActiveUserId() ?? '');
  const [creating, setCreating] = useState(false);

  const applyProfile = useCallback((next: UserProfile) => {
    setProfile(next);
    setName(next.name);
    setEmail(next.email);
  }, []);

  const refreshUsers = useCallback(async () => {
    const list = await userProfileApi.listUsers();
    setUsers(list);
    return list;
  }, []);

  const refreshProfile = useCallback(async () => {
    const next = await userProfileApi.get();
    applyProfile(next);
    return next;
  }, [applyProfile]);

  useEffect(() => {
    let canceled = false;
    Promise.all([userProfileApi.get(), userProfileApi.listUsers()])
      .then(([p, list]) => {
        if (canceled) return;
        applyProfile(p);
        setUsers(list);
        const active =
          list.find((user) => user.active) ?? list.find((user) => user.id === p.id) ?? list[0];
        if (active) {
          setActiveUserId(String(active.id));
          setActiveUserIdState(String(active.id));
        }
      })
      .catch((err) => {
        if (!canceled) setError(getErrorMessage(err, 'Failed to load profile'));
      });
    return () => {
      canceled = true;
    };
  }, [applyProfile]);

  const onSelectUser = useCallback(
    async (id: string) => {
      if (!id || switching || id === activeUserId) return;
      setSwitching(true);
      setError(null);
      try {
        const active = await userProfileApi.setActive(id);
        setActiveUserId(String(active.id));
        setActiveUserIdState(String(active.id));
        applyProfile(active);
        await refreshUsers();
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to switch active user'));
      } finally {
        setSwitching(false);
      }
    },
    [activeUserId, applyProfile, refreshUsers, switching]
  );

  // The user already exists once this runs (the modal has closed), so a
  // failed refresh is reported here rather than left as an unhandled rejection.
  const onCreated = useCallback(
    async (created: UserProfile, makeActive: boolean) => {
      setCreating(false);
      setSavedAt(Date.now());
      setError(null);
      try {
        await refreshUsers();
        if (makeActive) {
          setActiveUserId(String(created.id));
          setActiveUserIdState(String(created.id));
          await refreshProfile();
        }
      } catch (err) {
        setError(getErrorMessage(err, 'User created, but the user list could not be refreshed'));
      }
    },
    [refreshProfile, refreshUsers]
  );

  const onSave = useCallback(async () => {
    if (!profile) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await userProfileApi.update({
        name: name.trim(),
        email: email.trim(),
      });
      applyProfile(updated);
      setSavedAt(Date.now());
    } catch (err) {
      setError(getErrorMessage(err, 'Save failed'));
      return;
    } finally {
      setSaving(false);
    }
    // The profile is saved at this point; a failed list refresh must not
    // report the save itself as failed.
    try {
      await refreshUsers();
    } catch (err) {
      setError(getErrorMessage(err, 'Saved, but the user list could not be refreshed'));
    }
  }, [applyProfile, email, name, profile, refreshUsers]);

  if (!profile && !error) {
    return (
      <div className={styles.shell}>
        <StateHint>Loading profile…</StateHint>
      </div>
    );
  }

  const dirty = profile != null && (name.trim() !== profile.name || email.trim() !== profile.email);

  return (
    <div className={styles.shell}>
      <div className={styles.body}>
        <header className={styles.header}>
          <h1 className={styles.title}>My profile</h1>
        </header>

        <div className={styles.field}>
          <div className={styles.fieldHeaderRow}>
            <label className={styles.fieldLabel} htmlFor="profile-active-user">
              Acting as
            </label>
            <Button
              variant="neutral"
              size="sm"
              onClick={() => setCreating(true)}
              disabled={saving || switching}
            >
              Create user
            </Button>
          </div>
          <Select
            id="profile-active-user"
            value={activeUserId}
            onChange={(e) => void onSelectUser(e.target.value)}
            disabled={saving || switching || users.length === 0}
          >
            {users.length === 0 && <option value="">No users available</option>}
            {users.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.name} ({u.email})
              </option>
            ))}
          </Select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="profile-name">
            Name
          </label>
          <TextInput
            id="profile-name"
            type="text"
            fullWidth
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
            placeholder="Your name"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="profile-email">
            Email
          </label>
          <TextInput
            id="profile-email"
            type="email"
            fullWidth
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={saving}
            placeholder="you@example.com"
          />
        </div>

        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}

        <footer className={styles.actions}>
          {/* Idle says nothing — a form that hasn't been touched has no status
              worth announcing. Only real transitions speak: switching, unsaved,
              just-saved. */}
          <span className={styles.statusText} aria-live="polite">
            {switching ? 'Switching user…' : dirty ? 'Unsaved changes' : savedAt ? 'Saved' : ''}
          </span>
          <Button
            variant="primary"
            size="md"
            onClick={() => void onSave()}
            disabled={!dirty}
            loading={saving}
            loadingText="Saving…"
          >
            Save
          </Button>
        </footer>
      </div>
      {creating && <CreateUserModal onClose={() => setCreating(false)} onCreated={onCreated} />}
    </div>
  );
};
