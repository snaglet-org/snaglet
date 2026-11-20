import { memo, useEffect, useMemo, useState, type FC, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { WikiLinkPreviewModal } from '@desktop/features/rich-markdown/preview/WikiLinkPreviewModal';
import { Chip } from './Chip';
import { ExpandableCell } from './ExpandableCell';
import { MarkdownTable } from './MarkdownTable';
import { MermaidDiagram } from './MermaidDiagram';
import { isMermaidBlock } from './isMermaidBlock';
import { TransclusionBlock, MAX_TRANSCLUSION_DEPTH } from './TransclusionBlock';
import { INCLUDABLE_KINDS, hasTableRowLinkByName, parseNodeRef } from './nodeRef';
import rehypeOffsetMarkers from './offsetMarkers';
import remarkBareNodeRefs from './remarkBareNodeRefs';
import remarkImageMarkers from './remarkImageMarkers';
import remarkLiftImageParagraphs from './remarkLiftImageParagraphs';
import remarkTableCellBreaks from './remarkTableCellBreaks';
import remarkTableCellTasks from './remarkTableCellTasks';
import { AuthenticatedImageContent } from '@desktop/components/AuthenticatedImageContent/AuthenticatedImageContent';
import {
  ensureAgents,
  getAgentsCached,
} from '@desktop/features/rich-markdown/editor/agentMentionCache';
import { ensureTableNames, tableNamesLoaded } from '@desktop/features/database/tableNameCache';
import { useHorizontalWheelScroll } from '@desktop/hooks/useHorizontalWheelScroll';
import { WHEEL_SCROLL_X_PROPS } from '@desktop/utils/horizontalWheelScroll';
import styles from './MarkdownRenderer.module.scss';

/**
 * react-markdown's default transform empties URLs with unknown schemes, which
 * would include node refs like `page:`. Node refs pass through (they render
 * as chips, never navigate); everything else gets the default sanitizer.
 */
function nodeAwareUrlTransform(value: string): string {
  if (parseNodeRef(value)) return value;
  return defaultUrlTransform(value);
}

/**
 * A stored image, written as `![](image-…)`, `<image id="…"/>` or
 * `[filename.png](image-…)`. All three render this preview, not a chip.
 */
function StoredImagePreview({ imageId, alt }: { imageId: string; alt?: string | null }) {
  // Load through AuthenticatedImageContent (fetch → blob), not a raw `<img>`:
  // a native image load skips the fetch wrapper that adds the x-snaglet-token
  // header, so packaged builds would get a 401. CSP img-src allows blob:.
  // A click opens the image node in the preview modal.
  const [showPreview, setShowPreview] = useState(false);
  return (
    <>
      <a
        href={imageId}
        className={styles.storedImageLink}
        data-node-kind="image"
        data-node-id={imageId}
        data-node-url={imageId}
        onClick={(e) => {
          e.preventDefault();
          // Shift-click stays with the surface that owns the source markdown.
          if (e.shiftKey) return;
          e.stopPropagation();
          setShowPreview(true);
        }}
      >
        <AuthenticatedImageContent
          imageId={imageId}
          alt={alt?.trim() || 'Attached image'}
          className="snaglet-stored-image"
        />
      </a>
      {showPreview && (
        <WikiLinkPreviewModal kind="image" id={imageId} onClose={() => setShowPreview(false)} />
      )}
    </>
  );
}

interface MarkdownRendererProps {
  content: string;
  renderFileLink?: (href: string, children: ReactNode) => ReactNode;
  renderFileImage?: (src: string, alt: string) => ReactNode;
  className?: string;
  /** "Show as link" on a transclusion block: receives the href and the live
   *  doc title (null if not loaded) so an editor can rewrite it as a link. */
  onConvertIncludeToLink?: (href: string, liveTitle: string | null) => void;
  /** Render the link/include toggle on doc chips, for a host that owns the
   *  markdown and handles the toggle's click (ChipEditableInput's preview).
   *  Default false: read-only renderings (chat messages, previews, a
   *  transclusion's content) show no edit controls on their chips. */
  showIncludeToggle?: boolean;
  /** Called from a chip's "×" button to strip it from the source. The button
   *  shows only when this is set. */
  onChipRemove?: (href: string) => void;
  /** Transclusion nesting depth, 0 at the top. At MAX_TRANSCLUSION_DEPTH, transclusions
   *  render as chips so self-including docs can't recurse forever. */
  depth?: number;
  /** Called when a GFM task checkbox is clicked; `sourceOffset` is the list
   *  item's offset in the raw markdown. When set, checkboxes are enabled. */
  onCheckboxToggle?: (sourceOffset: number, checked: boolean) => void;
}

/**
 * Render markdown with react-markdown and remark-gfm. Links to node refs
 * render as `Chip`s; `![](doc-…)` renders as a `TransclusionBlock`, and
 * other node images as include-marked chips. A small rehype plugin stamps
 * task checkboxes with their source offsets.
 */
const MarkdownRendererImpl: FC<MarkdownRendererProps> = ({
  content,
  renderFileLink,
  renderFileImage,
  className,
  onConvertIncludeToLink,
  showIncludeToggle = false,
  onChipRemove,
  depth = 0,
  onCheckboxToggle,
}) => {
  // Bumped once a lookup cache (agents, table names) warms, so mentions and
  // row links parsed before it re-render as chips.
  const [lookupVersion, setLookupVersion] = useState(0);
  // One delegated wheel listener for the rendered subtree, for the regions
  // that overflow sideways (code block, table, or this root in chat bubbles).
  // In a page that scrolls vertically each wheel gesture keeps to one axis,
  // so scrolling down over a table moves the page only; a region with no
  // vertical scrolling around it takes a plain vertical wheel sideways.
  const wheelScrollRef = useHorizontalWheelScroll<HTMLDivElement>();

  // Mentions parsed before the agent roster loaded re-parse once it does.
  // Only that first load bumps the version, because the bump remounts the
  // tree and resets table sorting and expanded cells.
  const agentsCold = getAgentsCached() === null;
  useEffect(() => {
    if (!agentsCold || !content.includes('@')) return;
    let canceled = false;
    void ensureAgents().then(() => {
      // A failed load leaves the roster cold; re-parsing would change nothing.
      if (!canceled && getAgentsCached() !== null) setLookupVersion((version) => version + 1);
    });
    return () => {
      canceled = true;
    };
  }, [content, agentsCold]);

  // A row linked by its table's name (`[Title](tasks:<uuid>)`) chips only once
  // the table catalog says which names are tables.
  useEffect(() => {
    if (tableNamesLoaded() || !hasTableRowLinkByName(content)) return;
    let canceled = false;
    void ensureTableNames().then(() => {
      // A failed load leaves the links as they are; re-parsing would change nothing.
      if (!canceled && tableNamesLoaded()) setLookupVersion((version) => version + 1);
    });
    return () => {
      canceled = true;
    };
  }, [content]);

  // Memoized so react-markdown sees a stable components identity.
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        // A link to a heading of the same doc (`#h=…`, `#slug`) has no doc
        // view to scroll here: it opens nothing, never a new window. A file
        // preview handles its own fragments (it scrolls inside the preview).
        if (href?.startsWith('#') && !renderFileLink) {
          return (
            <a href={href} onClick={(event) => event.preventDefault()}>
              {children}
            </a>
          );
        }
        const ref = href ? parseNodeRef(href) : null;
        if (!ref) {
          if (href && renderFileLink) return renderFileLink(href, children);
          return (
            <a href={href} target="_blank" rel="noopener">
              {children}
            </a>
          );
        }
        if (ref.kind === 'image') {
          return (
            <StoredImagePreview
              imageId={ref.id}
              alt={typeof children === 'string' ? children : null}
            />
          );
        }
        return (
          <Chip
            kind={ref.kind}
            nodeId={ref.id}
            anchor={ref.anchor}
            href={href!}
            title={children as ReactNode}
            showIncludeToggle={showIncludeToggle}
            onRemove={onChipRemove}
          />
        );
      },
      img: ({ src, alt, node }) => {
        const ref = typeof src === 'string' ? parseNodeRef(src) : null;
        if (!ref) {
          if (typeof src === 'string' && renderFileImage) return renderFileImage(src, alt ?? '');
          // Not a node reference: a plain image.
          return <img src={src as string | undefined} alt={alt ?? ''} />;
        }
        if (ref.kind === 'image') {
          // Stored image (`image-{id}`).
          return <StoredImagePreview imageId={ref.id} alt={alt} />;
        }
        // `remarkLiftImageParagraphs` lifts includable images out of
        // paragraphs. Block transclusions render as TransclusionBlock, or as a
        // chip at max depth to stop recursion.
        const isBlockInclude =
          INCLUDABLE_KINDS.has(ref.kind) &&
          node?.properties != null &&
          'data-block-include' in node.properties;
        if (isBlockInclude) {
          if (depth >= MAX_TRANSCLUSION_DEPTH) {
            return (
              <Chip
                kind={ref.kind}
                nodeId={ref.id}
                href={src!}
                title={alt ?? ''}
                include
                showIncludeToggle={false}
              />
            );
          }
          return (
            <TransclusionBlock
              href={src!}
              title={alt ?? ''}
              depth={depth}
              onToggleToLink={
                onConvertIncludeToLink
                  ? (liveTitle) => onConvertIncludeToLink(src!, liveTitle)
                  : undefined
              }
              onRemove={onChipRemove ? () => onChipRemove(src!) : undefined}
            />
          );
        }
        // Fallback for an include image left inline.
        return (
          <Chip
            kind={ref.kind}
            nodeId={ref.id}
            href={src!}
            title={alt ?? ''}
            include
            showIncludeToggle={showIncludeToggle}
            onRemove={onChipRemove}
          />
        );
      },

      // Tables render in MarkdownTable: a frame that scrolls a wide table
      // inside itself, header sorting, and a hover bar with Copy and Expand.
      // A module-level component, so its sort survives this map's rebuilds.
      table: MarkdownTable,

      // Code blocks are marked as their own horizontal wheel-scroll region;
      // Mermaid fences render as diagrams. `node` is the hast node, not a
      // DOM prop.
      pre: ({ children, node, ref: _ref, ...rest }) => {
        const code = node?.children[0];
        if (code?.type === 'element' && code.tagName === 'code') {
          const source = code.children
            .map((child) => (child.type === 'text' ? child.value : ''))
            .join('')
            .replace(/\n$/, '');
          const classes = code.properties.className;
          const language = Array.isArray(classes)
            ? classes
                .find((name) => String(name).startsWith('language-'))
                ?.toString()
                .slice(9)
            : undefined;
          if (isMermaidBlock(language, source))
            return (
              <div className={rest.className}>
                <MermaidDiagram source={source} />
              </div>
            );
        }
        return (
          <pre {...rest} {...WHEEL_SCROLL_X_PROPS}>
            {children}
          </pre>
        );
      },

      // Body cells show two lines of long prose and open in place on
      // click/keyboard when there is more. `style` carries the GFM
      // column-alignment (text-align); `className` is MarkdownTable's
      // numeric-column class. Nothing else is emitted on a `td`.
      td: ({ children, style, className }) => (
        <ExpandableCell style={style} className={className}>
          {children}
        </ExpandableCell>
      ),

      // Interactive task checkboxes, only when a handler is given. The key
      // must be absent otherwise: hast-util-to-jsx-runtime checks
      // hasOwnProperty, so `input: undefined` crashes every <input>.
      ...(onCheckboxToggle && {
        input: ({ type, checked, node, ...rest }) => {
          if (type !== 'checkbox') return <input type={type} checked={checked} {...rest} />;
          // The rehype plugin's source offset: from the hast node, else the
          // React prop.
          const raw =
            (node?.properties as Record<string, unknown>)?.['data-source-offset'] ??
            (rest as Record<string, unknown>)['data-source-offset'];
          const sourceOffset = raw != null ? Number(raw) : undefined;
          // Keep the GFM props, minus the non-DOM offset and `disabled`: a
          // checkbox with a source offset toggles; one without stays inert.
          const {
            'data-source-offset': _dso,
            disabled: _disabled,
            ...safeRest
          } = rest as Record<string, unknown>;
          return (
            <input
              {...safeRest}
              type="checkbox"
              disabled={sourceOffset === undefined || isNaN(sourceOffset)}
              checked={!!checked}
              onChange={(e) => {
                e.stopPropagation();
                if (sourceOffset !== undefined && !isNaN(sourceOffset)) {
                  onCheckboxToggle(sourceOffset, e.target.checked);
                }
              }}
            />
          );
        },
      }),
    }),
    [
      onConvertIncludeToLink,
      showIncludeToggle,
      onChipRemove,
      depth,
      onCheckboxToggle,
      renderFileLink,
      renderFileImage,
    ]
  );

  return (
    <div
      ref={wheelScrollRef}
      className={`${styles.markdown} ${className ?? ''}`}
      {...WHEEL_SCROLL_X_PROPS}
    >
      <ReactMarkdown
        key={lookupVersion}
        remarkPlugins={[
          remarkGfm,
          remarkTableCellBreaks,
          remarkTableCellTasks,
          remarkImageMarkers,
          remarkBareNodeRefs,
          remarkLiftImageParagraphs,
        ]}
        rehypePlugins={[rehypeOffsetMarkers]}
        urlTransform={nodeAwareUrlTransform}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

/**
 * Memoized: hosts re-render far more often than their markdown changes (chat
 * rows on every agent step), and the props are usually strings or stable
 * callbacks.
 */
export const MarkdownRenderer = memo(MarkdownRendererImpl);
