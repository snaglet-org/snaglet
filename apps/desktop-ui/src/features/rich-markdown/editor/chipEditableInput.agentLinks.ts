import type { Mark } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { parseNodeRef } from '@desktop/features/rich-markdown/renderer/nodeRef';

interface AgentLinkRange {
  from: number;
  to: number;
  href: string;
  title: string;
  /** Marks besides the link that the whole label carries (`**[Name](id)**` is bold). */
  marks: readonly Mark[];
}

/**
 * Turn `[Name](agent-id)` links into agent chips once the shared roster knows
 * the agent. The rich parser chips a link only for an agent the roster held
 * when it ran, so an agent created or restored later stays a plain link until
 * this runs. Only those links change: the rest of the document, the caret and
 * the undo history stay as they are, and the host hears no edit. (Re-parsing
 * the whole document would not do: rich markdown drops blank paragraphs.)
 */
export function chipKnownAgentLinks(ed: Editor): boolean {
  const { doc, schema } = ed.state;
  const chipType = schema.nodes.chip;
  const linkType = schema.marks.link;
  if (!chipType || !linkType) return false;

  const ranges: AgentLinkRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const link = linkType.isInSet(node.marks);
    const href: unknown = link?.attrs.href;
    if (!link || typeof href !== 'string' || parseNodeRef(href)?.kind !== 'agent') return;
    const last = ranges[ranges.length - 1];
    // Formatting splits one link into several text nodes; the chip takes the
    // whole label, and only the marks all of it carries, as a reload would.
    if (last && last.to === pos && last.href === href) {
      last.to += node.nodeSize;
      last.title += node.text ?? '';
      last.marks = last.marks.filter((mark) => mark.isInSet(node.marks));
    } else {
      ranges.push({
        from: pos,
        to: pos + node.nodeSize,
        href,
        title: node.text ?? '',
        marks: link.removeFromSet(node.marks),
      });
    }
  });
  if (ranges.length === 0) return false;

  const { tr } = ed.state;
  for (const range of ranges.reverse()) {
    const chip = chipType.create(
      { href: range.href, title: range.title, include: false, kind: 'agent' },
      null,
      range.marks
    );
    tr.replaceWith(range.from, range.to, chip);
  }
  ed.view.dispatch(tr.setMeta('addToHistory', false).setMeta('preventUpdate', true));
  return true;
}
