import { beforeEach, describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';

// Mocks (hoisted by jest)
const mockPoolQuery = jest.fn();
const mockFindById = jest.fn();
const mockResolveDocByPath = jest.fn();
const mockExtractCanonicalReferences = jest.fn();
const mockLintCanonicalReferences = jest.fn();

jest.mock('@snaglet/db', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: jest.fn(() => ({ query: mockPoolQuery })),
  // Writes run in one transaction; its queries land on the same mock.
  transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({ query: mockPoolQuery })),
  // The real loop guard: it reads docs only when a batch adds a transclusion.
  assertNoTransclusionLoop: jest.requireActual<
    typeof import('../../../../../../../packages/db/tables/docs/transclusionLoop')
  >('../../../../../../../packages/db/tables/docs/transclusionLoop').assertNoTransclusionLoop,
}));

jest.mock('@snaglet/db/tables/docs', () => {
  return {
    Docs: { findById: mockFindById },
  };
});

// Also mock the resolved file path in case the alias is bypassed.
jest.mock('../../../../../../../packages/db/tables/docs/index.js', () => ({
  Docs: { findById: mockFindById },
}));

jest.mock('@server/services/WorkspaceService/pathResolver.js', () => ({
  resolveDocByPath: mockResolveDocByPath,
}));

jest.mock('@server/services/SocketService/outboundMessageLinter', () => ({
  extractCanonicalWorkspaceReferences: mockExtractCanonicalReferences,
  lintCanonicalWorkspaceReferencesInContent: mockLintCanonicalReferences,
}));

import editDocHandler from '../../../../../../../apps/server/src/services/ToolService/handlers/docs/editDoc';
import { runTool } from '../../../../../../support/toolHarness';
import docDefinition from '@server/services/ToolService/tools/docs/doc/definition';
import { WorkspaceEditDocInput } from '@server/services/ToolService/handlers/docs/docInputs';

const pgRows = (rows: unknown[]) => ({ rows });

/** The doc `Docs.findById` last returned, as the write transaction re-reads it. */
async function unchangedSinceRead(sql: unknown) {
  if (!/FOR (NO KEY )?UPDATE/.test(String(sql))) return pgRows([]);
  const results = mockFindById.mock.results;
  const doc = (await results[results.length - 1]?.value) as
    | { id: string; content: string | null }
    | undefined;
  return pgRows(doc ? [{ id: doc.id, content: doc.content, archived: false }] : []);
}

interface EditWarning {
  message?: string;
  affected_docs?: Array<{ doc_id: string; title?: string; action?: string }>;
}

interface EditDocResult {
  success?: boolean;
  doc_id?: string;
  edits_applied?: unknown[];
  preview?: Array<{ doc_id: string; old_content: string; new_content: string }>;
  warnings?: EditWarning[];
  backup_id?: string;
  backup_skipped_reason?: string;
}

/**
 * The default export is a ToolHandler wrapper returning { output, rawContent }.
 * We unwrap rawContent for assertions and pass empty settings/context.
 */
async function runEdit(input: unknown): Promise<EditDocResult> {
  return runTool<EditDocResult>(editDocHandler, input);
}

function makeDoc(overrides: Partial<{ id: string; title: string; content: string }> = {}) {
  return {
    id: 'doc-1',
    title: 'Doc 1',
    content: 'Hello world. Hello again.',
    container_id: null,
    sort_order: 0,
    ...overrides,
  };
}

describe('workspace_edit_doc', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockFindById.mockReset();
    mockResolveDocByPath.mockReset();
    mockExtractCanonicalReferences.mockReturnValue([]);
    mockLintCanonicalReferences.mockResolvedValue({
      content: '',
      issues: [],
      infrastructureError: false,
    });
    // Default — any unmocked pool.query resolves to an empty rowset, except
    // the in-transaction re-read, which finds the doc as it was loaded.
    // Individual tests still take precedence via `mockResolvedValueOnce`.
    mockPoolQuery.mockImplementation(unchangedSinceRead);
  });

  describe('input validation', () => {
    it('teaches empty-document first writes in both public schemas', () => {
      const inputDescription = WorkspaceEditDocInput.shape.edits.description;
      // doc(op:update) carries the edit_doc schema; the teaching lives in the
      // tool description and the old_text field.
      const jsonSchema = docDefinition.parameters_schema.properties.edits;
      const itemSchema = jsonSchema.items;

      expect(docDefinition.description).toContain('old_text: ""');
      expect(inputDescription).toContain('old_text: ""');
      expect(itemSchema.properties.old_text.description).toMatch(/empty doc/i);
      expect(itemSchema.properties.old_text.description).toMatch(/rejected.*has content/i);
    });

    it('documents empty old_text as an empty-doc-only initial write', () => {
      const toolDoc = readFileSync(
        'apps/server/src/services/ToolService/tools/docs/doc/TOOL.md',
        'utf8'
      );

      expect(toolDoc).toMatch(/\*\*Initial write\*\*.*Only when doc is empty\/NULL/);
      expect(toolDoc).toMatch(
        /For non-empty documents, use the exact existing text as `old_text` to anchor/
      );
      expect(toolDoc).toMatch(/empty `old_text` is only valid for the initial write/i);
      expect(toolDoc).toMatch(
        /To edit a non-empty document, use exact existing text as `old_text`/
      );
      expect(toolDoc).not.toMatch(/\*\*Insert\*\*.*Required \(where to insert\)/);
      expect(toolDoc).not.toMatch(/Missing Context for Insert/);
      expect(toolDoc).not.toMatch(/not found for insert operation/);
    });

    it('throws when neither doc_id nor doc_path is provided', async () => {
      await expect(runEdit({ edits: [{ old_text: 'a', new_text: 'b' }] })).rejects.toThrow(
        /Must specify either doc_id or doc_path/
      );
    });

    it('throws when both doc_id and doc_path are provided', async () => {
      await expect(
        runEdit({
          doc_id: 'doc-1',
          doc_path: '/x',
          edits: [{ old_text: 'a', new_text: 'b' }],
        })
      ).rejects.toThrow(/Cannot specify both doc_id and doc_path/);
    });

    it('throws when edits array is missing or empty', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      await expect(runEdit({ doc_id: 'doc-1', edits: [] })).rejects.toThrow(/edits/i);
    });

    it('throws when the document is not found', async () => {
      mockFindById.mockResolvedValueOnce(null);
      await expect(
        runEdit({
          doc_id: 'missing',
          edits: [{ old_text: 'a', new_text: 'b' }],
        })
      ).rejects.toThrow(/Document not found: missing/);
    });

    it('resolves doc_path via resolveDocByPath before lookup', async () => {
      mockResolveDocByPath.mockResolvedValueOnce('doc-from-path');
      mockFindById.mockResolvedValueOnce(makeDoc({ id: 'doc-from-path', content: 'Hello world' }));

      const result = await runEdit({
        doc_path: '/x/y',
        edits: [{ old_text: 'Hello', new_text: 'Hi' }],
      });

      expect(mockResolveDocByPath).toHaveBeenCalledWith('/x/y');
      expect(mockFindById).toHaveBeenCalledWith('doc-from-path');
      expect(result.doc_id).toBe('doc-from-path');
    });
  });

  describe('edits shape coercion + teaching error', () => {
    it('accepts a single {old_text,new_text} object and wraps it in an array', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Hello world.' }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: { old_text: 'world', new_text: 'there' }, // single object, not an array
        create_backup: false,
      });

      expect(result.success).toBe(true);
      expect(result.edits_applied).toHaveLength(1);
      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('UPDATE docs')
      );
      expect(updateCall![1][0]).toBe('Hello there.');
    });

    it('accepts edits passed as a JSON-string array', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Hello world.' }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: '[{"old_text":"world","new_text":"there"}]', // JSON string
        create_backup: false,
      });

      expect(result.success).toBe(true);
      expect(result.edits_applied).toHaveLength(1);
    });

    it('throws a teaching error (not a raw Zod dump) when edits is malformed', async () => {
      await expect(runEdit({ doc_id: 'doc-1', edits: 'totally not valid' })).rejects.toThrow(
        /edits.*must be an array of \{old_text, new_text\}/i
      );
    });

    it('teaching error names the array-of-objects shape when edits is missing', async () => {
      await expect(runEdit({ doc_id: 'doc-1' })).rejects.toThrow(
        /edits.*array of \{old_text, new_text\}/i
      );
    });
  });

  describe('edit application', () => {
    it('applies a simple unique edit and writes via UPDATE', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Hello world.' }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [{ old_text: 'world', new_text: 'there' }],
      });

      expect(result).toMatchObject({
        success: true,
        doc_id: 'doc-1',
      });
      expect(Array.isArray(result.edits_applied)).toBe(true);
      expect(result.edits_applied).toHaveLength(1);

      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('UPDATE docs')
      );
      expect(updateCall).toBeDefined();
      // Third param is last_edited_by (resolved actor member id) — null here
      // since no actor is bound in the unit context.
      expect(updateCall![1]).toEqual(['Hello there.', 'doc-1', null]);
    });

    it('applies multiple edits sequentially', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'foo bar baz' }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [
          { old_text: 'foo', new_text: 'FOO' },
          { old_text: 'baz', new_text: 'BAZ' },
        ],
      });

      expect(result.edits_applied).toHaveLength(2);
      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('UPDATE docs')
      );
      expect(updateCall![1][0]).toBe('FOO bar BAZ');
    });

    it('throws when old_text is not found in the document', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Hello world' }));

      await expect(
        runEdit({
          doc_id: 'doc-1',
          edits: [{ old_text: 'nonexistent', new_text: 'whatever' }],
        })
      ).rejects.toThrow(/not found|no match/i);
    });

    it('throws on ambiguous match without occurrence or context', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Hello world. Hello again.' }));

      await expect(
        runEdit({
          doc_id: 'doc-1',
          edits: [{ old_text: 'Hello', new_text: 'Hi' }],
        })
      ).rejects.toThrow(/ambiguous|multiple|occurrence/i);
    });

    it('disambiguates using the occurrence field', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Hello world. Hello again.' }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [{ old_text: 'Hello', new_text: 'Hi', occurrence: 2 }],
      });

      expect(result.edits_applied).toHaveLength(1);
      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('UPDATE docs')
      );
      expect(updateCall![1][0]).toBe('Hello world. Hi again.');
    });

    it('throws when occurrence is out of range', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Hello world. Hello again.' }));

      await expect(
        runEdit({
          doc_id: 'doc-1',
          edits: [{ old_text: 'Hello', new_text: 'Hi', occurrence: 5 }],
        })
      ).rejects.toThrow(/occurrence/i);
    });

    it('disambiguates using context_before', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'alpha foo end. beta foo end.' }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [
          {
            old_text: 'foo',
            new_text: 'FOO',
            context_before: 'beta ',
          },
        ],
      });

      expect(result.edits_applied).toHaveLength(1);
      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('UPDATE docs')
      );
      expect(updateCall![1][0]).toBe('alpha foo end. beta FOO end.');
    });

    // Empty old_text is a "pure insert" (as the schema documents), which is
    // the only way to first-write into an empty doc.
    it('first-writes into an empty doc when old_text is empty', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: '' }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [{ old_text: '', new_text: 'Brand new body' }],
        create_backup: false,
      });

      expect(result.success).toBe(true);
      expect(result.edits_applied).toHaveLength(1);

      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('UPDATE docs')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toEqual(['Brand new body', 'doc-1', null]);
    });

    it('previews an empty-doc first write without persisting it', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: '' }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [{ old_text: '', new_text: 'Brand new body' }],
        validate_only: true,
      });

      expect(result.preview).toEqual([
        { doc_id: 'doc-1', title: 'Doc 1', old_content: '', new_content: 'Brand new body' },
      ]);
      expect(mockPoolQuery).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE docs'),
        expect.anything()
      );
    });

    // Also covers docs whose `content` column is NULL (Docs.findById can
    // return `null` for that column when the row was created without a body).
    it('first-writes into a doc with null content', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: null as unknown as string }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [{ old_text: '', new_text: 'Seeded' }],
        create_backup: false,
      });

      expect(result.success).toBe(true);
      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('UPDATE docs')
      );
      expect(updateCall![1]).toEqual(['Seeded', 'doc-1', null]);
    });

    // The schema documents empty old_text as "pure insert", but without an
    // anchor there is no *where* to put it in a non-empty doc, so it is
    // rejected with a clear message instead of failing silently.
    it('rejects empty old_text on a non-empty doc with a clear message', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'already has content' }));

      await expect(
        runEdit({
          doc_id: 'doc-1',
          edits: [{ old_text: '', new_text: 'inserted' }],
        })
      ).rejects.toThrow(/pure insert .* only supported on empty docs/i);
    });

    it('disambiguates using context_after', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'foo bar. foo baz.' }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [
          {
            old_text: 'foo',
            new_text: 'FOO',
            context_after: ' baz',
          },
        ],
      });

      expect(result.edits_applied).toHaveLength(1);
      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('UPDATE docs')
      );
      expect(updateCall![1][0]).toBe('foo bar. FOO baz.');
    });
  });

  describe('validate_only / preview mode', () => {
    it('does not run UPDATE when validate_only is true', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Hello world' }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [{ old_text: 'world', new_text: 'there' }],
        validate_only: true,
      });

      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('UPDATE docs')
      );
      expect(updateCall).toBeUndefined();

      expect(result.success).toBe(true);
      expect(result.preview).toEqual([
        { doc_id: 'doc-1', title: 'Doc 1', old_content: 'Hello world', new_content: 'Hello there' },
      ]);
    });
  });

  describe('transclusion change tracking', () => {
    it('rejects a newly-added unverified canonical reference before UPDATE', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Plain' }));
      mockExtractCanonicalReferences.mockImplementation((content: string) =>
        content.includes('doc-9999999999999-fabricated')
          ? [{ id: 'doc-9999999999999-fabricated', nodeType: 'doc' }]
          : []
      );
      mockLintCanonicalReferences.mockResolvedValueOnce({
        content: 'Plain [Missing](doc-9999999999999-fabricated)',
        issues: [{ id: 'doc-9999999999999-fabricated', nodeType: 'doc', reason: 'not_found' }],
        infrastructureError: false,
      });

      await expect(
        runEdit({
          doc_id: 'doc-1',
          edits: [
            {
              old_text: 'Plain',
              new_text: 'Plain [Missing](doc-9999999999999-fabricated)',
            },
          ],
        })
      ).rejects.toThrow(/unverified workspace reference/i);
      expect(mockPoolQuery.mock.calls.some((call) => String(call[0]).includes('UPDATE docs'))).toBe(
        false
      );
    });

    it('rejects adding another occurrence of an existing unverified reference', async () => {
      const badRef = '[Missing](doc-9999999999999-fabricated)';
      mockFindById.mockResolvedValueOnce(makeDoc({ content: badRef }));
      mockExtractCanonicalReferences.mockImplementation((content: string) =>
        Array.from(content.matchAll(/doc-9999999999999-fabricated/g), () => ({
          id: 'doc-9999999999999-fabricated',
          nodeType: 'doc',
        }))
      );
      mockLintCanonicalReferences.mockResolvedValueOnce({
        content: `${badRef}\n${badRef}`,
        issues: [{ id: 'doc-9999999999999-fabricated', nodeType: 'doc', reason: 'not_found' }],
        infrastructureError: false,
      });

      await expect(
        runEdit({
          doc_id: 'doc-1',
          edits: [{ old_text: badRef, new_text: `${badRef}\n${badRef}` }],
        })
      ).rejects.toThrow(/unverified workspace reference/i);
      expect(mockPoolQuery.mock.calls.some((call) => String(call[0]).includes('UPDATE docs'))).toBe(
        false
      );
    });

    it('emits a warning when a transclusion is added', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Plain text' }));
      // doc lookup for the added/removed transclusions
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ id: 'doc-ref-1', title: 'Referenced' }]));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [{ old_text: 'Plain text', new_text: 'Plain text ![](doc-ref-1)' }],
      });

      const transclusionWarning = result.warnings!.find(
        (w) => Array.isArray(w.affected_docs) && w.affected_docs.length > 0
      );
      expect(transclusionWarning).toBeDefined();
      expect(transclusionWarning!.affected_docs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            doc_id: 'doc-ref-1',
            title: 'Referenced',
            action: 'added',
          }),
        ])
      );
    });

    it('emits a warning when a transclusion is removed', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Body ![](doc-ref-1) more' }));
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ id: 'doc-ref-1', title: 'Referenced' }]));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [{ old_text: 'Body ![](doc-ref-1) more', new_text: 'Body more' }],
      });

      const transclusionWarning = result.warnings!.find(
        (w) => Array.isArray(w.affected_docs) && w.affected_docs.length > 0
      );
      expect(transclusionWarning).toBeDefined();
      expect(transclusionWarning!.affected_docs).toEqual([
        expect.objectContaining({
          doc_id: 'doc-ref-1',
          action: 'removed',
        }),
      ]);
    });

    it('throws when an added transclusion names a doc that does not exist', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Plain' }));
      mockPoolQuery.mockResolvedValueOnce(pgRows([])); // doc lookup finds nothing

      await expect(
        runEdit({
          doc_id: 'doc-1',
          edits: [{ old_text: 'Plain', new_text: 'Plain ![](doc-ghost)' }],
        })
      ).rejects.toThrow(/nonexistent doc\(s\): doc-ghost/);
    });

    it('does not look up docs when no transclusion changes', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Hello' }));

      await runEdit({
        doc_id: 'doc-1',
        edits: [{ old_text: 'Hello', new_text: 'Hi' }],
        create_backup: false, // disable auto-snapshot to keep this assertion focused
      });

      const sqls = mockPoolQuery.mock.calls.map((c) => String(c[0]));
      expect(sqls.some((s) => /UPDATE docs/.test(s))).toBe(true);
      expect(sqls.some((s) => /UPDATE nodes/.test(s))).toBe(true);
      // Only the write transaction's locked re-read (node, then doc) names ids.
      expect(sqls.filter((s) => /ANY\(\$1\)/.test(s))).toEqual([
        expect.stringContaining('FROM nodes'),
        expect.stringContaining('FROM docs'),
      ]);
    });
  });

  describe('response shape', () => {
    it('returns the expected response keys on success', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Hello' }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [{ old_text: 'Hello', new_text: 'Hi' }],
      });

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          doc_id: 'doc-1',
          edits_applied: expect.any(Array),
          warnings: expect.any(Array),
        })
      );
    });

    it('does not include backup_id or backup_skipped_reason when create_backup is false', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Hello' }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [{ old_text: 'Hello', new_text: 'Hi' }],
        create_backup: false,
      });

      expect(result.backup_id).toBeUndefined();
      expect(result.backup_skipped_reason).toBeUndefined();
    });
  });

  describe('create_backup integration with doc_snapshots', () => {
    it('writes a doc_snapshots row with the pre-edit content and returns backup_id', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Original content' }));

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [{ old_text: 'Original', new_text: 'Updated' }],
        create_backup: true,
      });

      // backup_id should be present and snap-prefixed
      expect(result.backup_id).toMatch(/^snap-\d+-[A-Za-z0-9_-]{8}$/);
      expect(result.backup_skipped_reason).toBeUndefined();

      // INSERT into doc_snapshots must happen before the UPDATE
      const insertIdx = mockPoolQuery.mock.calls.findIndex(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO doc_snapshots')
      );
      const updateIdx = mockPoolQuery.mock.calls.findIndex(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('UPDATE docs')
      );
      expect(insertIdx).toBeGreaterThanOrEqual(0);
      expect(updateIdx).toBeGreaterThan(insertIdx);

      // The snapshot content must be the original pre-edit content
      const insertParams = mockPoolQuery.mock.calls[insertIdx]![1] as unknown[];
      expect(insertParams[2]).toBe('Original content');
      expect(insertParams[3]).toBe(Buffer.byteLength('Original content', 'utf8'));
      expect(insertParams[4]).toBe('pre-edit');
    });

    it('still performs the edit when snapshot INSERT fails, returning backup_skipped_reason', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Original content' }));
      mockPoolQuery.mockImplementation(async (sql: unknown) => {
        if (String(sql).includes('INSERT INTO doc_snapshots')) {
          throw new Error('relation "doc_snapshots" does not exist');
        }
        return unchangedSinceRead(sql);
      });

      const result = await runEdit({
        doc_id: 'doc-1',
        edits: [{ old_text: 'Original', new_text: 'Updated' }],
        create_backup: true,
      });

      expect(result.success).toBe(true);
      expect(result.backup_id).toBeUndefined();
      expect(result.backup_skipped_reason).toMatch(/Auto-snapshot failed/);

      // UPDATE still happened with the new content
      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('UPDATE docs')
      );
      expect(updateCall![1][0]).toBe('Updated content');
      // The failed snapshot rolled back to its savepoint, keeping the transaction usable.
      const sqls = mockPoolQuery.mock.calls.map((c) => String(c[0]));
      expect(sqls).toContain('ROLLBACK TO SAVEPOINT edit_doc_backup');
    });
  });
});

describe('workspace_edit_doc: a deadlock', () => {
  it('reports a retryable message and writes nothing', async () => {
    mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Hello' }));
    mockPoolQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('UPDATE docs SET')) {
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      }
      return unchangedSinceRead(sql);
    });
    await expect(
      runEdit({ doc_id: 'doc-1', edits: [{ old_text: 'Hello', new_text: 'Hi' }] })
    ).rejects.toThrow('read them again and retry. Nothing was saved.');
  });
});
