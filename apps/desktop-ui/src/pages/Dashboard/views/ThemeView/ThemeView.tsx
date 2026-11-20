import React, { useSyncExternalStore } from 'react';
import { DEFAULT_THEME_NAME } from '@snaglet/theme';
import {
  subscribeTheme,
  getThemeSaveError,
  resetWorkspaceTheme,
} from '@desktop/utils/workspaceTheme';
import styles from './ThemeView.module.scss';
import { setShowAgentPopups, useShowAgentPopups } from '@desktop/utils/displayPrefs';
import { ColorPicker } from './ColorPicker';
import { baseColorTokens, containerColorTokens, nodeColorTokens } from './colorTokens';

export const ThemeView: React.FC = () => {
  const showAgentPopups = useShowAgentPopups();
  const saveError = useSyncExternalStore(subscribeTheme, getThemeSaveError, () => '');
  const handleResetAll = () => {
    void resetWorkspaceTheme();
  };

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Workspace theme</h1>
          <button
            type="button"
            onClick={handleResetAll}
            className={styles.resetAll}
            title={`Put every color back to the default theme, ${DEFAULT_THEME_NAME}`}
          >
            Reset to {DEFAULT_THEME_NAME}
          </button>
        </div>
        <p className={styles.subtitle}>
          Your colors personalize this workspace and guide new artwork made with your agents. The
          default theme is {DEFAULT_THEME_NAME}.
        </p>
      </header>
      <div className={styles.body}>
        {saveError && <p role="alert">{saveError}</p>}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Agent popups</h2>
          {/* Client display preference (localStorage), applies live. */}
          <label className={styles.toggleRow}>
            <input
              type="checkbox"
              className={styles.toggleInput}
              checked={showAgentPopups}
              onChange={(e) => setShowAgentPopups(e.target.checked)}
            />
            <span className={styles.toggleText}>
              <span className={styles.toggleTitle}>Show agent popups</span>
              <span className={styles.toggleDescription}>
                When an agent asks a question or needs permission in a chat that is not on screen,
                pop up its avatar with the question so you can answer without opening the chat.
              </span>
            </span>
          </label>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Base palette</h2>
          <div className={styles.grid}>
            {baseColorTokens.map((token) => (
              <ColorPicker
                key={token.name}
                name={token.name}
                label={token.label}
                description={token.description}
                defaultValue={token.defaultValue}
              />
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Containers</h2>
          <div className={styles.grid}>
            {containerColorTokens.map((token) => (
              <ColorPicker
                key={token.name}
                name={token.name}
                label={token.label}
                description={token.description}
                defaultValue={token.defaultValue}
              />
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Docs, threads, agents, tools, memories, images</h2>
          <div className={styles.grid}>
            {nodeColorTokens.map((token) => (
              <ColorPicker
                key={token.name}
                name={token.name}
                label={token.label}
                description={token.description}
                defaultValue={token.defaultValue}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
