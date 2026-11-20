import type { RefObject } from 'react';
import type { Editor } from '@tiptap/react';

import { filePathToChipHref } from '@desktop/features/rich-markdown/renderer/nodeRef';
import { paletteSearchApi, type PaletteFileNodeItem } from '@desktop/utils/api/palette-search';

import { agentChipTitle } from './NodeMentionSearch';
import { ensureAgents, findAgentByHandle, getAgentsCached } from './agentMentionCache';
import {
  filePathCandidateAtSelection,
  TYPED_MENTION_AT_CARET_RE,
} from './chipEditableInput.helpers';

export interface AgentAutoCompleteDeps {
  enableNodeMentionsRef: RefObject<boolean>;
  disabledRef: RefObject<boolean | undefined>;
  pendingAgentMentionRetryRef: RefObject<boolean>;
}

// Typed-mention autocomplete: when `@<name><whitespace>` at the caret names a
// cached agent exactly, replace the text with an agent chip, like the bare-id
// input rule. Synchronous so it can run during `onUpdate`.
export function autoCompleteAgent(ed: Editor, deps: AgentAutoCompleteDeps): boolean {
  const { enableNodeMentionsRef, disabledRef, pendingAgentMentionRetryRef } = deps;
  if (!enableNodeMentionsRef.current || disabledRef.current) return false;
  const agents = getAgentsCached();
  if (!agents) {
    if (!pendingAgentMentionRetryRef.current) {
      pendingAgentMentionRetryRef.current = true;
      void ensureAgents().then(() => {
        pendingAgentMentionRetryRef.current = false;
        // Only a roster that arrived can complete the mention; re-running
        // after a failed load would start the next load at once, in a loop.
        if (getAgentsCached() && !ed.isDestroyed) autoCompleteAgent(ed, deps);
      });
    }
    return false;
  }
  if (agents.length === 0) return false;

  const { selection } = ed.state;
  if (!selection.empty) return false;
  const { from, $from } = selection;
  if ($from.parent.type.name !== 'paragraph') return false;

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n');
  const match = TYPED_MENTION_AT_CARET_RE.exec(textBefore);
  if (!match) return false;

  // Everything after `@` up to the caret. `name` below drops the trailing
  // whitespace and sets the replace span.
  const typed = match[1];
  // Convert only after a trailing delimiter. A bare exact name stays a live
  // suggestion: the user may keep typing, or press Enter in the popover.
  if (typed === typed.trimEnd()) return false;
  const agent = findAgentByHandle(agents, typed);
  if (!agent) return false;
  const name = typed.trimEnd();
  if (!name) return false;

  const chipType = ed.state.schema.nodes.chip;
  if (!chipType) return false;
  const chip = chipType.create({
    href: agent.id,
    title: agentChipTitle({
      type: 'agent',
      key: agent.id,
      label: agent.name || 'Agent',
      subtitle: null,
      agent: {
        id: agent.id,
        name: agent.name ?? null,
        handle: null,
        role: agent.role ?? null,
      },
      prefix: true,
    }),
    include: false,
    kind: 'agent',
  });

  // Replace exactly `@<name>` and keep the trailing whitespace. The span is
  // measured from the trimmed name because the match runs to the caret.
  const trailingWsLen = typed.length - name.length;
  const replaceTo = from - trailingWsLen; // end of `@name`
  const replaceFrom = replaceTo - name.length - 1; // the `@`

  ed.chain()
    .command(({ tr, dispatch }) => {
      tr.replaceWith(replaceFrom, replaceTo, chip);
      dispatch?.(tr.scrollIntoView());
      return true;
    })
    .run();
  return true;
}

export interface FilePathAutoCompleteDeps {
  disabledRef: RefObject<boolean | undefined>;
  filePathResolutionCacheRef: RefObject<Map<string, PaletteFileNodeItem | null>>;
  pendingFilePathResolutionsRef: RefObject<Set<string>>;
}

export function autoCompleteFilePath(ed: Editor, deps: FilePathAutoCompleteDeps): boolean {
  const { disabledRef, filePathResolutionCacheRef, pendingFilePathResolutionsRef } = deps;
  if (disabledRef.current) return false;
  const candidate = filePathCandidateAtSelection(ed);
  if (!candidate) return false;

  const cached = filePathResolutionCacheRef.current.get(candidate.path);
  if (cached === undefined) {
    if (!pendingFilePathResolutionsRef.current.has(candidate.path)) {
      pendingFilePathResolutionsRef.current.add(candidate.path);
      void paletteSearchApi
        .resolveFilePath(candidate.path)
        .then((hit) => {
          filePathResolutionCacheRef.current.set(candidate.path, hit);
          if (!ed.isDestroyed) autoCompleteFilePath(ed, deps);
        })
        .catch(() => {
          filePathResolutionCacheRef.current.set(candidate.path, null);
        })
        .finally(() => {
          pendingFilePathResolutionsRef.current.delete(candidate.path);
        });
    }
    return false;
  }
  if (!cached) return false;

  const chipType = ed.state.schema.nodes.chip;
  if (!chipType) return false;
  const chip = chipType.create({
    // Absolute path so the chip resolves / previews on disk; the relative
    // path stays as the readable title.
    href: filePathToChipHref(cached.absolutePath),
    title: cached.relativePath,
    include: false,
    kind: 'file',
  });

  ed.chain()
    .command(({ tr, dispatch }) => {
      tr.replaceWith(candidate.from, candidate.to, chip);
      dispatch?.(tr.scrollIntoView());
      return true;
    })
    .run();
  return true;
}
