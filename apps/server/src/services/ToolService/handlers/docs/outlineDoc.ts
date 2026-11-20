import { docOutline, formatHeadingFragment } from '@snaglet/shared/utils';
import { loadDocForRead } from './getDoc';

export interface DocOutline {
  id: string;
  title: string;
  /** Lines in the stored source; 0 for an empty doc. */
  total_lines: number;
  headings: Array<{ level: number; text: string; line: number; anchor: string }>;
}

/**
 * The headings of a doc's stored source, each with its line and the `#h=`
 * anchor that reads its section. Lines count the stored source, as `#L…`
 * part reads and search's content_range do, so an agent can outline a doc and
 * then read one block. A transcluded doc's headings are not in that source
 * and are not listed; outline that doc to see them.
 */
export default async function outlineDoc(params: {
  doc_id?: string;
  doc_path?: string;
  include_archived?: boolean;
}): Promise<DocOutline> {
  const doc = await loadDocForRead(params);
  const content = doc.content ?? '';
  return {
    id: doc.id,
    title: doc.title,
    total_lines: content === '' ? 0 : content.split('\n').length,
    headings: docOutline(content).map((h) => ({
      level: h.level,
      text: h.text,
      line: h.line,
      anchor: `#${formatHeadingFragment(h.ref)}`,
    })),
  };
}
