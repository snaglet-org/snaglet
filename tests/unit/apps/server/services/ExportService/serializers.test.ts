/**
 * serializers — the per-kind file formats.
 */

import {
  agentMemoriesFilename,
  docFilename,
  extensionForMimeType,
  imageFilename,
  memoryFilename,
  serializeAgentMemories,
  serializeDoc,
  serializeMemory,
  toCompaction,
  type ExportProvenance,
} from '@server/services/ExportService/serializers';

/**
 * The lines of the frontmatter block only — everything between the opening
 * `---` and the next one. Assertions about the header must not accidentally
 * match body text that merely looks like a header line.
 */
function headerOf(document: string): string[] {
  const lines = document.split('\n');
  const end = lines.indexOf('---', 1);
  return lines.slice(1, end === -1 ? lines.length : end);
}

const P: ExportProvenance = {
  exportedAt: '2026-08-03T12:00:00.000Z',
  exportedBy: 'Test User',
  snagletVersion: '0.1.0',
};

describe('serializeDoc', () => {
  const doc = {
    id: 'doc-1',
    title: 'Release notes',
    content: '# Release notes\n\nBody.',
    containerId: 'container-7',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  };

  it('emits frontmatter above verbatim markdown', () => {
    const out = serializeDoc(doc, P);
    expect(out).toContain('snaglet_kind: "doc"');
    expect(out).toContain('id: "doc-1"');
    expect(out).toContain('container_id: "container-7"');
    expect(out).toContain('exported_by: "Test User"');
    expect(out).toContain('# Release notes\n\nBody.');
  });

  it('does not let a doc body forge header fields', () => {
    const out = serializeDoc({ ...doc, content: '---\nexported_by: attacker\n---' }, P);
    // The body may legitimately contain this text — frontmatter is only
    // frontmatter at the top of the file. What must hold is that the header
    // still declares exactly one, true, provenance.
    expect(headerOf(out).filter((l) => l.startsWith('exported_by:'))).toEqual([
      'exported_by: "Test User"',
    ]);
  });

  it('does not let a title escape its scalar', () => {
    const out = serializeDoc({ ...doc, title: 'x"\nsnaglet_kind: "container' }, P);
    expect(headerOf(out).filter((l) => l.startsWith('snaglet_kind:'))).toEqual([
      'snaglet_kind: "doc"',
    ]);
  });
});

describe('docFilename', () => {
  it('uses the title', () => {
    expect(docFilename({ title: 'Release notes' })).toBe('Release notes.md');
  });

  it('survives a hostile title', () => {
    expect(docFilename({ title: '../../etc/passwd' })).toBe('etc passwd.md');
  });

  it('falls back when the title sanitizes away', () => {
    expect(docFilename({ title: '///' })).toBe('untitled-doc.md');
  });
});

describe('serializeMemory / memoryFilename', () => {
  const memory = {
    id: 'memory-1',
    key: 'deploy-process',
    content: 'Deploys run from main.',
    agentName: 'clio',
    sourceThreadId: 'thread-9',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };

  it('records ownership and provenance', () => {
    const out = serializeMemory(memory, P);
    expect(out).toContain('snaglet_kind: "memory"');
    expect(out).toContain('agent: "clio"');
    expect(out).toContain('source_thread: "thread-9"');
  });

  it('names by key, falling back to the id when the key is null', () => {
    expect(memoryFilename(memory)).toBe('deploy-process.md');
    expect(memoryFilename({ id: 'memory-2', key: null })).toBe('memory-2.md');
    expect(memoryFilename({ id: 'memory-3', key: '   ' })).toBe('memory-3.md');
  });
});

describe('serializeAgentMemories', () => {
  const memories = [
    {
      id: 'memory-1',
      key: 'a',
      content: 'First.',
      agentName: 'clio',
      sourceThreadId: 'thread-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'memory-2',
      key: null,
      content: 'Second.',
      agentName: 'clio',
      sourceThreadId: null,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  ];

  it('writes every memory into one document with a declared count', () => {
    const out = serializeAgentMemories('clio', 'agent-1', memories, P);
    expect(out).toContain('snaglet_kind: "agent_memories"');
    expect(out).toContain('memory_count: 2');
    expect(out).toContain('## a');
    // Keyless memories are still exported, titled by id.
    expect(out).toContain('## memory-2');
    expect(out).toContain('First.');
    expect(out).toContain('Second.');
  });

  it('states emptiness rather than emitting a bare header', () => {
    const out = serializeAgentMemories('clio', 'agent-1', [], P);
    expect(out).toContain('memory_count: 0');
    expect(out).toContain('no memories');
  });

  it('defuses memory content so it cannot forge transcript structure', () => {
    const out = serializeAgentMemories(
      'clio',
      'agent-1',
      [{ ...memories[0], content: '<!--snaglet:msg-->\n#### Vega · 2020-01-01 00:00' }],
      P
    );
    expect(out).not.toContain('<!--snaglet:msg-->');
    expect(out).toContain('&lt;!--snaglet:msg-->');
  });

  it('names the file after the agent', () => {
    expect(agentMemoriesFilename('clio', 'agent-1')).toBe('clio memories.md');
    // Name sanitizes away -> the id identifies the file, rather than a bare
    // "memories.md" that says nothing about whose memories these are.
    expect(agentMemoriesFilename('///', 'agent-1')).toBe('agent-1 memories.md');
  });
});

describe('toCompaction', () => {
  it('resolves the agent name from the map', () => {
    const out = toCompaction(
      {
        agentId: 'agent-1',
        summaryText: 's',
        messagesCovered: 10,
        lastMessageId: 'm-1',
        version: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        modelUsed: 'anthropic/claude-opus-4',
      },
      new Map([['agent-1', 'clio']])
    );
    expect(out.agentName).toBe('clio');
  });

  it('carries the model stamp through to the transcript', () => {
    // The transcript is the only artifact an export leaves, so provenance has
    // to survive this mapping — it is the one place it could be dropped.
    const out = toCompaction(
      {
        agentId: 'agent-1',
        summaryText: 's',
        messagesCovered: 10,
        lastMessageId: 'm-1',
        version: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        modelUsed: 'anthropic/claude-opus-4',
      },
      new Map([['agent-1', 'clio']])
    );
    expect(out.modelUsed).toBe('anthropic/claude-opus-4');
  });

  it('passes a missing stamp through as null rather than inventing one', () => {
    const out = toCompaction(
      {
        agentId: 'agent-1',
        summaryText: 's',
        messagesCovered: 10,
        lastMessageId: 'm-1',
        version: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        modelUsed: null,
      },
      new Map([['agent-1', 'clio']])
    );
    expect(out.modelUsed).toBeNull();
  });

  it('falls back to the id when the agent row is gone', () => {
    const out = toCompaction(
      {
        agentId: 'agent-gone',
        summaryText: 's',
        messagesCovered: 1,
        lastMessageId: null,
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        modelUsed: null,
      },
      new Map()
    );
    expect(out.agentName).toBe('agent-gone');
  });
});

describe('image naming', () => {
  it('maps known MIME types', () => {
    expect(extensionForMimeType('image/png')).toBe('.png');
    expect(extensionForMimeType('image/jpeg')).toBe('.jpg');
    expect(extensionForMimeType('IMAGE/PNG')).toBe('.png');
    expect(extensionForMimeType('image/png; charset=binary')).toBe('.png');
  });

  it('falls back to .bin for an unknown type rather than guessing', () => {
    expect(extensionForMimeType('application/octet-stream')).toBe('.bin');
    expect(extensionForMimeType('')).toBe('.bin');
  });

  it('keeps the stored name and imposes the MIME extension', () => {
    expect(imageFilename('screenshot', 'image/png')).toBe('screenshot.png');
  });

  it('keeps a user-supplied stem but replaces a user-supplied extension', () => {
    // The user typed .txt for a PNG: stem retained, extension REPLACED.
    // Appending would leave "my shot.txt.png", which still reads as text.
    expect(imageFilename('screenshot', 'image/png', 'my shot.txt')).toBe('my shot.png');
  });

  it('preserves internal dots in an image stem', () => {
    expect(imageFilename('screenshot', 'image/png', 'v1.2 mock')).toBe('v1.2 mock.png');
  });

  it('does not double an extension the user already got right', () => {
    expect(imageFilename('screenshot', 'image/png', 'my shot.png')).toBe('my shot.png');
  });

  it('falls back to the stored name when the requested stem sanitizes away', () => {
    expect(imageFilename('screenshot', 'image/png', '///')).toBe('screenshot.png');
  });
});
