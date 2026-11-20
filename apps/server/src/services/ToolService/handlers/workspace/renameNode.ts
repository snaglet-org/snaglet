/**
 * rename — rename a doc, container or image.
 *
 * For docs, optionally rewrites the visible label of every inbound inline
 * reference (![label](doc-id)) in other docs to the new title. This keeps
 * the rendered text in sync without breaking any link IDs.
 *
 * Inline-label rewrite uses the `links` table to find candidate source docs
 * (avoiding a full table scan), then a per-doc regex substitution.
 *
 * An image renames through `Images.rename`, the same call the sidebar uses,
 * so its stored file takes the new name too. Images may share a name.
 */
import type { ToolHandler } from '@server/services/ToolService/types';
import { Containers, Docs, Links, Nodes } from '@snaglet/db';
import { Images } from '@snaglet/db/tables/images';
import { resolveNodeByPath } from '@server/services/WorkspaceService/pathResolver';
import { assertNotArchived } from '@server/services/ToolService/tools/_shared/archiveGuard';
import { hooks } from '@server/services/HookService';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import { emitTreeNodeUpdated, emitDocBodySaved } from '@server/realtime/surfaces/tree';
import { escapeRegex, imageNameProblem, unique } from '@snaglet/shared/utils';

type RenameKind = 'doc' | 'container' | 'image';

interface Input {
  id?: string;
  path?: string;
  kind?: RenameKind;
  new_title: string;
  update_inline_labels?: boolean;
  validate_only?: boolean;
  allow_archived?: boolean;
}

interface ToolResult {
  output: string;
  rawContent: Record<string, unknown>;
}

function toolResult(result: Record<string, unknown>): ToolResult {
  return { output: JSON.stringify(result, null, 2), rawContent: result };
}

async function classifyId(id: string): Promise<RenameKind> {
  const [doc, container] = await Promise.all([Docs.findById(id), Containers.findById(id)]);
  if (doc) return 'doc';
  if (container) return 'container';
  if ((await Nodes.getType(id)) === 'image') return 'image';
  throw new Error(`rename: node not found for id "${id}"`);
}

/** Rename an image and its stored file; emits the same tree update as the sidebar. */
async function renameImage(
  id: string,
  newTitle: string,
  input: Input,
  validateOnly: boolean
): Promise<ToolResult> {
  const problem = imageNameProblem(newTitle);
  if (problem) throw new Error(`rename: ${problem} Nothing was changed.`);
  const current = await Images.findMetaById(id);
  if (!current) throw new Error(`rename: image not found: ${id}`);
  assertNotArchived(current, { allow_archived: input.allow_archived });
  const oldTitle = current.name;
  const base = { success: true, kind: 'image', id, old_title: oldTitle, new_title: newTitle };
  if (oldTitle === newTitle) {
    return toolResult({
      ...base,
      noop: true,
      message: `rename: name unchanged ("${newTitle}"), no action taken`,
    });
  }
  if (validateOnly) {
    return toolResult({
      ...base,
      validate_only: true,
      message: `rename: validate_only — would rename image ${id} and its stored file from "${oldTitle}" to "${newTitle}"`,
    });
  }
  const outcome = await Images.rename(id, newTitle, { expectedName: oldTitle });
  if (outcome.status === 'missing') throw new Error(`rename: image not found: ${id}`);
  if (outcome.status === 'conflict') {
    throw new Error(
      `rename: image ${id} was renamed to "${outcome.currentName}" meanwhile. Nothing was changed.`
    );
  }
  emitTreeNodeUpdated({
    id,
    kind: 'image',
    title: outcome.image.name,
    updatedAt: outcome.image.updatedAt,
  });
  return toolResult({
    ...base,
    link: linkForm('image', id, newTitle),
    message: `Renamed image ${id} from "${oldTitle}" to "${newTitle}"; its stored file was renamed too`,
  });
}

/**
 * Rewrite every `![label](docId)` AND `[label](docId)` occurrence in
 * `content` to use `newLabel`. Preserves the embed vs. plain-link form
 * (the `!` prefix, if present, is kept verbatim). Returns the new content
 * and the count of substitutions.
 */
function rewriteInlineLabel(
  content: string,
  docId: string,
  newLabel: string
): { content: string; count: number } {
  const escapedId = escapeRegex(docId);
  // Optional `!` prefix is captured in group 1 so we can re-emit it.
  const re = new RegExp(`(!?)\\[([^\\]]*)\\]\\(${escapedId}\\)`, 'g');
  let count = 0;
  const next = content.replace(re, (_full, bang: string) => {
    count += 1;
    return `${bang}[${newLabel}](${docId})`;
  });
  return { content: next, count };
}

const handler: ToolHandler = async (rawInput, _settings, context) => {
  const input = (rawInput ?? {}) as unknown as Input;

  // Validate
  if (!input.id && !input.path) {
    throw new Error('rename: provide either `id` or `path`');
  }
  if (input.id && input.path) {
    throw new Error('rename: pass either `id` or `path`, not both');
  }
  const newTitle = (input.new_title ?? '').trim();
  if (!newTitle) {
    throw new Error('rename: `new_title` is required and must be non-empty');
  }
  const updateInlineLabels = input.update_inline_labels ?? true;
  const validateOnly = input.validate_only ?? false;

  // Resolve the node
  let kind: RenameKind;
  let nodeId: string;
  if (input.id) {
    nodeId = input.id;
    kind = input.kind ?? (await classifyId(input.id));
  } else {
    if (input.kind === 'image') throw new Error('rename: address an image by `id`, not `path`');
    const resolved = await resolveNodeByPath(input.path!, input.kind);
    kind = resolved.kind;
    nodeId = resolved.id;
  }
  if (kind === 'image') return renameImage(nodeId, newTitle, input, validateOnly);

  // Enforce sibling-unique title
  let oldTitle: string;
  let parentId: string | null;
  if (kind === 'doc') {
    const current = await Docs.findById(nodeId);
    if (!current) throw new Error(`rename: doc not found: ${nodeId}`);
    assertNotArchived(current, { allow_archived: input.allow_archived });
    oldTitle = current.title;
    parentId = current.containerId;
    if (oldTitle === newTitle) {
      const result = {
        success: true,
        kind,
        id: nodeId,
        old_title: oldTitle,
        new_title: newTitle,
        noop: true,
        message: `rename: title unchanged ("${newTitle}"), no action taken`,
      };
      return { output: JSON.stringify(result, null, 2), rawContent: result };
    }
    const siblings = await Docs.listByContainer(parentId);
    const collision = siblings.find(
      (d) =>
        d.id !== nodeId &&
        d.title.localeCompare(newTitle, undefined, { sensitivity: 'accent' }) === 0
    );
    if (collision) {
      throw new Error(
        `rename: sibling doc with title "${newTitle}" already exists (id=${collision.id})`
      );
    }
  } else {
    const current = await Containers.findById(nodeId);
    if (!current) throw new Error(`rename: container not found: ${nodeId}`);
    assertNotArchived(current, { allow_archived: input.allow_archived });
    oldTitle = current.name;
    parentId = current.parentId;
    if (oldTitle === newTitle) {
      const result = {
        success: true,
        kind,
        id: nodeId,
        old_title: oldTitle,
        new_title: newTitle,
        noop: true,
        message: `rename: name unchanged ("${newTitle}"), no action taken`,
      };
      return { output: JSON.stringify(result, null, 2), rawContent: result };
    }
    const siblings = await Containers.listByParent(parentId);
    const collision = siblings.find(
      (c) =>
        c.id !== nodeId &&
        c.name.localeCompare(newTitle, undefined, { sensitivity: 'accent' }) === 0
    );
    if (collision) {
      throw new Error(
        `rename: sibling container with name "${newTitle}" already exists (id=${collision.id})`
      );
    }
  }

  // Plan inline-label rewrites (docs only)
  const inlineUpdates: Array<{
    source_doc_id: string;
    source_title: string;
    occurrences: number;
  }> = [];
  if (kind === 'doc' && updateInlineLabels) {
    const incoming = await Links.filter({ targetId: nodeId });
    const sourceDocIds = unique(incoming.map((l) => l.sourceId));
    for (const sid of sourceDocIds) {
      if (sid === nodeId) continue; // self-refs are not labels we own
      const src = await Docs.findById(sid);
      if (!src) continue;
      const { count } = rewriteInlineLabel(src.content ?? '', nodeId, newTitle);
      if (count > 0) {
        inlineUpdates.push({
          source_doc_id: sid,
          source_title: src.title,
          occurrences: count,
        });
      }
    }
  }

  // validate_only: report and exit
  if (validateOnly) {
    const result = {
      success: true,
      kind,
      id: nodeId,
      old_title: oldTitle,
      new_title: newTitle,
      validate_only: true,
      inline_updates_planned: inlineUpdates,
      message: `rename: validate_only — would rename ${kind} ${nodeId} from "${oldTitle}" to "${newTitle}" and rewrite ${inlineUpdates.reduce((a, u) => a + u.occurrences, 0)} inline labels across ${inlineUpdates.length} docs`,
    };
    return { output: JSON.stringify(result, null, 2), rawContent: result };
  }

  // Apply the rename
  if (kind === 'doc') {
    const updated = await Docs.update(nodeId, { title: newTitle });
    if (!updated) throw new Error(`rename: doc update failed: ${nodeId}`);
    emitTreeNodeUpdated({
      id: nodeId,
      kind: 'doc',
      title: newTitle,
      updatedAt: updated.updatedAt,
    });
    hooks.emit('doc:rename', {
      id: nodeId,
      oldTitle,
      newTitle,
      ...(context?.hookOrigin ? { origin: context.hookOrigin } : {}),
    });
  } else {
    const updated = await Containers.update(nodeId, { name: newTitle });
    if (!updated) throw new Error(`rename: container update failed: ${nodeId}`);
    emitTreeNodeUpdated({
      id: nodeId,
      kind: 'container',
      title: newTitle,
      updatedAt: updated.updatedAt,
    });
  }

  // Apply inline-label rewrites
  const appliedUpdates: typeof inlineUpdates = [];
  if (kind === 'doc' && updateInlineLabels) {
    for (const u of inlineUpdates) {
      const src = await Docs.findById(u.source_doc_id);
      if (!src) continue;
      const { content: nextContent, count } = rewriteInlineLabel(
        src.content ?? '',
        nodeId,
        newTitle
      );
      if (count === 0) continue;
      const updatedSrc = await Docs.update(u.source_doc_id, { content: nextContent });
      if (updatedSrc) {
        emitDocBodySaved(
          u.source_doc_id,
          nextContent,
          updatedSrc.updatedAt,
          updatedSrc.lastEditedBy
        );
      }
      appliedUpdates.push({ ...u, occurrences: count });
    }
  }

  const linkScheme = kind === 'doc' ? 'doc' : 'container';
  const result = {
    success: true,
    kind,
    id: nodeId,
    old_title: oldTitle,
    new_title: newTitle,
    inline_updates_applied: appliedUpdates,
    link: linkForm(linkScheme, nodeId, newTitle),
    message: `Renamed ${kind} ${nodeId} from "${oldTitle}" to "${newTitle}"${appliedUpdates.length ? ` and rewrote ${appliedUpdates.reduce((a, u) => a + u.occurrences, 0)} inline labels across ${appliedUpdates.length} docs` : ''}`,
  };
  return { output: JSON.stringify(result, null, 2), rawContent: result };
};

export default handler;
