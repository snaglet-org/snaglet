import { useEffect, useState, type FC } from 'react';
import { skillsApi, type SkillFileContent, type SkillInfo } from '@desktop/utils/api/skills';
import { MarkdownRenderer } from '@desktop/features/rich-markdown/renderer';
import { getErrorMessage } from '@snaglet/shared/utils';
import styles from './SkillFileView.module.scss';

interface SkillFileViewProps {
  skillId: string;
  slug: string;
  path: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; file: SkillFileContent; skill: SkillInfo | null }
  | { status: 'error'; message: string };

/**
 * Split a leading `---` frontmatter block off markdown so it isn't rendered
 * as a rule + setext heading. The registry already parsed name/description
 * (shown in the meta block), so the viewer only needs the body.
 */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: null, body: text };
  return { frontmatter: m[1], body: text.slice(m[0].length) };
}

/** Re-read cadence while open, so an on-disk edit shows up live. */
const VIEW_REFRESH_MS = 5_000;

/**
 * Read-only viewer for one file in a skill folder. Markdown
 * renders; everything else shows as text. SKILL.md gets a header with its
 * folder path, 8-char version and status. No editing: skills are authored on
 * disk under ~/.snaglet/skills.
 */
export const SkillFileView: FC<SkillFileViewProps> = ({ skillId, slug, path }) => {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let canceled = false;
    let lastKey: string | null = null;
    const load = () => {
      Promise.all([
        skillsApi.file(skillId, path),
        path === 'SKILL.md'
          ? skillsApi.list().then((all) => all.find((s) => s.id === skillId) ?? null)
          : Promise.resolve(null),
      ])
        .then(([file, skill]) => {
          if (canceled) return;
          const key = `${file.content}\u0000${skill?.version ?? ''}|${skill?.status ?? ''}`;
          if (key === lastKey) return;
          lastKey = key;
          setState({ status: 'loaded', file, skill });
        })
        .catch((err) => {
          if (canceled) return;
          lastKey = null;
          setState({ status: 'error', message: getErrorMessage(err) });
        });
    };
    setState({ status: 'loading' });
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, VIEW_REFRESH_MS);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [skillId, path]);

  const isMarkdown = /\.(md|markdown)$/i.test(path);

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title} title={`${slug}/${path}`}>
          <span className={styles.slug}>{slug}</span>
          <span className={styles.sep}>/</span>
          {path}
        </h1>
        <span className={styles.badge}>read-only</span>
      </header>
      {state.status === 'loaded' && state.skill && (
        <dl className={styles.meta} data-testid="skill-meta">
          {state.skill.name && (
            <>
              <dt>Name</dt>
              <dd>{state.skill.name}</dd>
            </>
          )}
          {state.skill.description && (
            <>
              <dt>Description</dt>
              <dd className={styles.wrap}>{state.skill.description}</dd>
            </>
          )}
          <dt>Folder</dt>
          <dd>{state.skill.folderPath}</dd>
          <dt>Version</dt>
          <dd>{state.skill.version ?? '—'}</dd>
          <dt>Status</dt>
          <dd className={state.skill.status === 'valid' ? undefined : styles.bad}>
            {state.skill.status}
            {state.skill.error ? ` — ${state.skill.error}` : ''}
          </dd>
        </dl>
      )}
      <div className={styles.body}>
        {state.status === 'loading' && <div className={styles.notice}>Loading…</div>}
        {state.status === 'error' && (
          <div className={styles.notice}>Could not load file: {state.message}</div>
        )}
        {state.status === 'loaded' &&
          (isMarkdown ? (
            <div className={styles.markdown}>
              <MarkdownRenderer content={splitFrontmatter(state.file.content).body} />
            </div>
          ) : (
            <pre className={styles.code}>{state.file.content}</pre>
          ))}
      </div>
    </div>
  );
};
