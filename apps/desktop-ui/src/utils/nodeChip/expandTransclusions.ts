// expandTransclusions — replaces every `![](doc-x)` transclusion in a
// markdown string with the doc's full content, wrapped in a `<doc>` tag so
// consumers can tell where it starts and ends. The chat composer uses it at
// submit time so agents receive the doc text. On failure the `![](href)` is
// left in place for `TransclusionBlock` to render.

import { docsApi } from '@desktop/utils/api/docs';
import { unique } from '@snaglet/shared/utils';
import { INCLUDABLE_KINDS, parseNodeRef } from '@desktop/features/rich-markdown/renderer/nodeRef';

const INCLUDE_RE = /!\[\]\(([^)\s]+)\)/g;

interface FetchedDoc {
  title: string;
  content: string;
}

export async function expandTransclusions(text: string): Promise<string> {
  if (!text || !text.includes('![](')) return text;
  const matches = [...text.matchAll(INCLUDE_RE)];
  if (matches.length === 0) return text;

  // Dedupe — same doc referenced multiple times should fetch once.
  const uniqueHrefs = unique(matches.map((m) => m[1]));

  const fetched = new Map<string, FetchedDoc | null>();
  await Promise.all(
    uniqueHrefs.map(async (href) => {
      const ref = parseNodeRef(href);
      if (!ref || !INCLUDABLE_KINDS.has(ref.kind)) {
        fetched.set(href, null);
        return;
      }
      // For prefixed-id hrefs (`doc-abc-123`), pass the full href.
      // For the scheme form (`page:<uuid>`), pass the bare id.
      const docId = href.startsWith('doc-') ? href : ref.id;
      try {
        const doc = await docsApi.get(docId);
        fetched.set(href, { title: doc.title ?? '', content: doc.content ?? '' });
      } catch {
        fetched.set(href, null);
      }
    })
  );

  return text.replace(INCLUDE_RE, (whole, href: string) => {
    const doc = fetched.get(href);
    if (!doc) return whole;
    const safeTitle = doc.title.replace(/"/g, '&quot;');
    // Wrap in a self-describing tag. Trailing newlines isolate the
    // inclusion from surrounding prose so wrapping/parsing stays clean.
    return `\n\n<doc id="${href}" title="${safeTitle}">\n${doc.content}\n</doc>\n\n`;
  });
}
