/**
 * Integration smoke test: full workspace tool-chain.
 *
 * Exercises:
 *   create_container → create_doc → get_doc → edit_doc → snapshot_doc
 *   → edit_doc (again) → diff_doc → list_recent → restore_snapshot → diff_doc
 *   → duplicate_doc → rename → move → delete_doc → cleanup containers
 *
 * Hits the real database.
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { Containers } from '@snaglet/db/tables/containers';
import { Docs } from '@snaglet/db/tables/docs';
import createContainer from '@server/services/ToolService/handlers/containers/createContainer';
import createDoc from '@server/services/ToolService/handlers/docs/createDoc';
import getDoc from '@server/services/ToolService/handlers/docs/getDoc';
import editDoc from '@server/services/ToolService/handlers/docs/editDoc';
import docHistory from '@server/services/ToolService/tools/docs/doc/tool';
import diffDoc from '@server/services/ToolService/handlers/docs/diffDoc';
import listRecent from '@server/services/ToolService/handlers/search/listRecent';
import duplicateDoc from '@server/services/ToolService/handlers/docs/duplicateDoc';
import rename from '@server/services/ToolService/handlers/workspace/renameNode';
import move from '@server/services/ToolService/handlers/workspace/moveNode';
import deleteDoc from '@server/services/ToolService/handlers/docs/deleteDoc';

function unpack<T = unknown>(out: unknown): T {
  if (out && typeof out === 'object' && 'rawContent' in (out as Record<string, unknown>)) {
    return (out as Record<string, unknown>).rawContent as T;
  }
  if (typeof out === 'string') return JSON.parse(out) as T;
  return out as T;
}

async function call<T = unknown>(
  handler: (input: never, ctx: never, meta: never) => Promise<unknown>,
  input: Record<string, unknown>
): Promise<T> {
  const out = await handler(input as never, {} as never, {} as never);
  return unpack<T>(out);
}

describe('workspace tool-chain (integration smoke)', () => {
  const suffix = `-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const n = (base: string) => `${base}${suffix}`;

  const containerIds: string[] = [];
  const docIds: string[] = [];

  afterAll(async () => {
    for (let i = docIds.length - 1; i >= 0; i--) {
      try {
        await Docs.delete(docIds[i]);
      } catch {
        /* best-effort */
      }
    }
    for (let i = containerIds.length - 1; i >= 0; i--) {
      try {
        await Containers.delete(containerIds[i]);
      } catch {
        /* best-effort */
      }
    }
  });

  it('runs the full lifecycle end-to-end', async () => {
    // 1. Create a container
    const c = await call<Record<string, unknown>>(createContainer, { name: n('Lifecycle Folder') });
    expect(c.success).toBe(true);
    containerIds.push(c.container.id);

    // 2. Create a doc inside the container
    const d = await call<Record<string, unknown>>(createDoc, {
      title: n('Lifecycle Doc'),
      content: 'Line one\nLine two\nLine three',
      container_id: c.container.id,
    });
    expect(d.success).toBe(true);
    docIds.push(d.doc.id);

    // 3. Get the doc back
    const got = await call<Record<string, unknown>>(getDoc, { doc_id: d.doc.id });
    expect(got.id).toBe(d.doc.id);
    expect(got.content).toContain('Line one');

    // 4. Edit the doc — add a snapshot first via explicit snapshot_doc
    const snap1 = await call<Record<string, unknown>>(docHistory, {
      op: 'snapshot',
      // Direct handler call: ToolExecutor normally applies id -> doc_id first.
      doc_id: d.doc.id,
      label: 'before-first-edit',
    });
    expect(snap1.success).toBe(true);
    const snap1Id: string = snap1.snapshot_id as string;

    // 5. Edit
    const edited = await call<Record<string, unknown>>(editDoc, {
      doc_id: d.doc.id,
      edits: [{ old_text: 'Line two', new_text: 'Line two (edited)' }],
    });
    expect(edited.success).toBe(true);

    // 6. Diff against the snapshot
    const diff1 = await call<Record<string, unknown>>(diffDoc, {
      doc_id: d.doc.id,
      from_snapshot_id: snap1Id,
    });
    expect(diff1.identical).toBe(false);
    expect(diff1.summary.added_lines).toBeGreaterThanOrEqual(1);
    expect(diff1.summary.removed_lines).toBeGreaterThanOrEqual(1);

    // 7. list_recent should include our doc
    const recent = await call<Record<string, unknown>>(listRecent, {
      container_id: c.container.id,
      limit: 10,
    });
    expect(recent.success).toBe(true);
    expect(recent.items.some((i: Record<string, unknown>) => i.id === d.doc.id)).toBe(true);

    // 8. Restore to the original snapshot
    const restored = await call<Record<string, unknown>>(docHistory, {
      op: 'restore',
      snapshot_id: snap1Id,
    });
    expect(restored.success).toBe(true);
    expect(restored.noop).not.toBe(true);

    // 9. Diff again — should be identical now
    const diff2 = await call<Record<string, unknown>>(diffDoc, {
      doc_id: d.doc.id,
      from_snapshot_id: snap1Id,
    });
    expect(diff2.identical).toBe(true);

    // 10. Duplicate the doc
    const dup = await call<Record<string, unknown>>(duplicateDoc, {
      source_id: d.doc.id,
      new_title: n('Lifecycle Doc Copy'),
    });
    expect(dup.success).toBe(true);
    docIds.push(dup.doc.id);

    // 11. Rename the duplicate
    const ren = await call<Record<string, unknown>>(rename, {
      id: dup.doc.id,
      new_title: n('Lifecycle Doc Copy Renamed'),
      update_inline_labels: false,
    });
    expect(ren.success).toBe(true);
    expect(ren.new_title).toContain('Renamed');

    // 12. Move the duplicate to root
    const moved = await call<Record<string, unknown>>(move, {
      id: dup.doc.id,
      new_parent_id: null,
    });
    expect(moved.success).toBe(true);
    expect(moved.moved.new_parent_id).toBeNull();

    // 13. Delete the duplicate (force=false since no other docs reference it)
    const del = await call<Record<string, unknown>>(deleteDoc, {
      doc_id: dup.doc.id,
    });
    expect(del.success).toBe(true);
    // remove from cleanup list since we just deleted it
    docIds.splice(docIds.indexOf(dup.doc.id), 1);
  }, 60_000);
});
