import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownRenderer } from '@desktop/features/rich-markdown/renderer';
import { getRelativeFile, relativeFileUrl, type FileContent } from '@desktop/utils/api/files';
import { getErrorMessage } from '@snaglet/shared/utils';
import { FileContentBody } from './FileContentBody';
import styles from './FilePreview.module.scss';

export function isRelativeFileUrl(href: string): boolean {
  return !!href && !/^(?:#|\/|[a-z][a-z\d+.-]*:)/i.test(href);
}

function FileImage({
  source,
  href,
  root,
  alt,
}: {
  source: string;
  href: string;
  root?: string;
  alt: string;
}) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let blobUrl: string | undefined;
    let canceled = false;
    const controller = new AbortController();
    setUrl(undefined);
    setFailed(false);
    void (async () => {
      try {
        const response = await fetch(relativeFileUrl(source, href, root, true), {
          signal: controller.signal,
        });
        if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/'))
          throw new Error('Missing image');
        const blob = await response.blob();
        if (canceled) return;
        blobUrl = URL.createObjectURL(blob);
        setUrl(blobUrl);
      } catch {
        if (!canceled) setFailed(true);
      }
    })();
    return () => {
      canceled = true;
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [source, href, root]);
  if (failed)
    return <span role="status">Image unavailable: {alt || href} (missing or outside project)</span>;
  return url ? (
    <img src={url} alt={alt} onError={() => setFailed(true)} />
  ) : (
    <span role="status">Loading image: {alt || href}…</span>
  );
}

/** Local navigation stays inside this preview, without opening filesystem URLs. */
export function FileMarkdownPreview({ data, source }: { data: FileContent; source: string }) {
  const [linked, setLinked] = useState<FileContent>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const host = useRef<HTMLDivElement>(null);
  useEffect(
    () => () => {
      request.current++;
    },
    []
  );
  const fragment = useRef('');
  const scrollAnchor = useCallback((href: string) => {
    const slug = decodeURIComponent(href.slice(1));
    const headings = host.current?.querySelectorAll('h1,h2,h3,h4,h5,h6');
    Array.from(headings ?? [])
      .find(
        (heading) =>
          heading.textContent
            ?.toLowerCase()
            .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
            .replace(/\s/g, '-') === slug
      )
      ?.scrollIntoView({ block: 'start' });
  }, []);
  useEffect(() => {
    if (linked && fragment.current) {
      try {
        scrollAnchor(fragment.current);
      } catch {
        /* malformed fragment */
      }
    }
  }, [linked, scrollAnchor]);
  const navigate = async (href: string) => {
    const current = ++request.current;
    setLoading(true);
    setError('');
    try {
      const result = await getRelativeFile(source, href, data.projectRoot);
      if (current === request.current) {
        fragment.current = href.includes('#') ? href.slice(href.indexOf('#')) : '';
        setLinked(result);
      }
    } catch (err) {
      if (current === request.current) setError(getErrorMessage(err));
    } finally {
      if (current === request.current) setLoading(false);
    }
  };
  if (linked)
    return (
      <div ref={host}>
        <button
          type="button"
          onClick={() => {
            request.current++;
            setLinked(undefined);
          }}
        >
          Back to {data.relativePath}
        </button>
        <div>{linked.relativePath}</div>
        <FileContentBody
          data={linked}
          fileName={linked.relativePath}
          rawSource={{ kind: 'path', path: linked.id }}
        />
      </div>
    );
  return (
    <div ref={host}>
      {loading && <div role="status">Loading linked file…</div>}
      {error && <div role="alert">Could not open linked file: {error}</div>}
      <MarkdownRenderer
        content={data.content ?? ''}
        className={styles.markdown}
        renderFileLink={(href, children) =>
          href.startsWith('#') ? (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                try {
                  scrollAnchor(href);
                } catch {
                  /* malformed fragment */
                }
              }}
            >
              {children}
            </a>
          ) : isRelativeFileUrl(href) ? (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                void navigate(href);
              }}
            >
              {children}
            </a>
          ) : (
            <a href={href} target="_blank" rel="noopener">
              {children}
            </a>
          )
        }
        renderFileImage={(href, alt) =>
          isRelativeFileUrl(href) ? (
            <FileImage source={source} href={href} root={data.projectRoot} alt={alt} />
          ) : (
            <img src={href} alt={alt} />
          )
        }
      />
    </div>
  );
}
