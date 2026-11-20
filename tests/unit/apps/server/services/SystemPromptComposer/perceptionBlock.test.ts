/**
 * perceptionBlock — the capability sections (docs and tasks, memory, browser,
 * computer, and the keyword-only search note). Every section is gated on the
 * tools the agent actually holds, keyed on canonical tool ids. Per-tool
 * mechanics (pane driving, script orchestration, parameter shapes, the browser
 * and computer tools' own rules) live on each tool's definition, what the
 * agent can see is goldenRulesBlock's, and the workspace-vs-filesystem model
 * is taught once in operatingContextBlock.
 */
import { perceptionBlock } from '@server/services/SystemPromptComposer/blocks/perceptionBlock';
import browserDefinition from '@server/services/ToolService/tools/system/browser/definition';
import computerDefinition from '@server/services/ToolService/tools/system/computer/definition';

function ctx(toolIds: string[], embeddingsEnabled = false): unknown {
  return {
    agentTools: toolIds.map((id) => ({ tool: { id } })),
    embeddingsEnabled,
    runKind: 'realtime_thread',
  };
}

async function textFor(toolIds: string[], embeddingsEnabled = false): Promise<string | null> {
  const block = await perceptionBlock(
    ctx(toolIds, embeddingsEnabled) as Parameters<typeof perceptionBlock>[0]
  );
  if (block === null) return null;
  return (block as { text?: string }).text ?? '';
}

describe('perceptionBlock — gating and relocated mechanics', () => {
  test('returns null when the agent has no relevant tools at all', async () => {
    expect(await textFor([])).toBeNull();
    // `node` alone writes neither docs nor tables and does not search.
    expect(await textFor(['node'])).toBeNull();
  });

  test('carries no pane mechanics, script orchestration or Filesystem section', async () => {
    const text = (await textFor(['search', 'shell', 'file', 'pane'])) ?? '';
    expect(text).not.toContain('## User interface');
    expect(text).not.toContain('## Script orchestration');
    expect(text).not.toContain('~/.snaglet/scripts');
    expect(text).not.toContain('## Filesystem');
    expect(text).not.toContain("Snaglet's database"); // taught once, in operatingContextBlock
  });
});

describe('perceptionBlock — Finding things', () => {
  test('leaves what the agent sees and where search reaches to the rules and the tool', async () => {
    const text = (await textFor(['search', 'memory'], true)) ?? '';
    // "You run in many threads" is goldenRules' "Check, don't assume"; where
    // search reaches is the search tool's description; when to load
    // snaglet-search is that skill's catalog line.
    expect(text).not.toContain('## Finding things');
    expect(text).not.toContain('You run in many threads');
    expect(text).not.toContain('snaglet-search');
    expect(text).not.toContain('a person');
    expect(text).not.toContain('before substantial new work');
  });

  test('leaves the web route to the web_search tool description', async () => {
    const text = (await textFor(['search'])) ?? '';
    expect(text).not.toContain('`web_search`');
  });

  test('does not carry the per-kind retrieval routes (they live in snaglet-search)', async () => {
    const text = (await textFor(['search', 'memory'])) ?? '';
    for (const moved of [
      '`resolve_path`',
      "`kind: 'files'`",
      "`kinds: ['message']`",
      '`include_archived`',
    ]) {
      expect(text).not.toContain(moved);
    }
  });

  test('says meaning search is unavailable only when embeddings are unavailable', async () => {
    expect(await textFor(['search'], false)).toContain(
      '## Finding things\nMeaning search is unavailable'
    );
    // With meaning search on, a search-only agent needs no section at all.
    expect(await textFor(['search'], true)).toBeNull();
    expect(await textFor(['search'], false)).toContain(
      'Meaning search is unavailable, so search in precise keywords.'
    );
  });
});

describe('perceptionBlock — Docs and tables', () => {
  const DOCS_AND_TABLES =
    "## Docs and tables\nUse docs for prose and tables for structured records you need to filter, sort or relate. Tasks can be tracked as table rows, with fields such as status, due date and assignee, and an optional linked doc for details. Follow the user's existing organization.";

  test('describes tasks as one thing a table can hold, not a required workflow', async () => {
    const text = (await textFor(['doc', 'table'])) ?? '';
    expect(text).toContain(DOCS_AND_TABLES);
    for (const mandate of ['A task is a row', 'a status change is a field edit', 'must']) {
      expect({ mandate, found: text.includes(mandate) }).toEqual({ mandate, found: false });
    }
    // The doc tool's own description explains convert-to-container.
    expect(text).not.toContain('convert-to-container');
    // Where docs go (and editing rather than duplicating) is goldenRules' one policy.
    expect(text).not.toContain('rather than starting a duplicate');
  });

  test.each([
    // [tools, expected section or null, what it must not imply]
    [['table'], '## Tables\nUse tables for structured records', ['docs', 'linked doc']],
    [['doc'], "## Docs\nUse docs for prose. Follow the user's existing organization.", ['table']],
    [['search'], null, []],
    [['node'], null, []],
  ] as const)('%j: renders only what the agent can write', async (tools, expected, absent) => {
    const text = (await textFor([...tools], true)) ?? '';
    if (expected === null) {
      expect(text).not.toMatch(/## (Docs|Tables)/);
    } else {
      expect(text).toContain(expected);
      for (const word of absent) expect(text.toLowerCase()).not.toContain(word);
    }
  });

  test('a table-only agent is covered: tasks are rows it can track', async () => {
    const text = (await textFor(['table'])) ?? '';
    expect(text).toContain(
      'Tasks can be tracked as table rows, with fields such as status, due date and assignee.'
    );
  });

  test('keyword-search guidance follows the search tool alone, not docs or tables', async () => {
    expect(await textFor(['table'], false)).not.toContain('Meaning search is unavailable');
    expect(await textFor(['doc'], false)).not.toContain('Meaning search is unavailable');
    const searchOnly = (await textFor(['search'], false)) ?? '';
    expect(searchOnly).toContain('Meaning search is unavailable');
    expect(searchOnly).not.toMatch(/## (Docs|Tables)/);
  });

  test('carries no kanban, subtask or category vocabulary', async () => {
    const text = (await textFor(['search', 'memory', 'table', 'doc'])) ?? '';
    for (const stale of ['kanban', 'subtype', 'subtask', '- `status`', 'fixed at creation']) {
      expect(text).not.toContain(stale);
    }
    expect(text).not.toContain('## Structured data');
  });

  test('has no blank line after a heading', async () => {
    const text = (await textFor(['search', 'doc', 'table', 'memory', 'browser', 'computer'])) ?? '';
    expect(text).not.toMatch(/^#+ .*\n\n/m);
  });
});

describe('perceptionBlock — Memory', () => {
  test('opens for the memory tool: private store, automatic recall, proactive saving', async () => {
    const text = (await textFor(['memory'])) ?? '';
    expect(text).toContain('## Memory');
    expect(text).toContain('`memory` is your private long-term store');
    expect(text).toContain('recalled into your turn context each time you wake');
    // Read once here, not in every turn's recall header.
    expect(text).toContain(
      'Recalled memories may be stale. Verify mutable facts and consequential claims against current sources before acting. Use durable preferences unless current instructions or evidence contradict them; correct or delete stale memories of your own.'
    );
    // Saving is the default; the user or the agent's instructions can turn it off.
    expect(text).toContain('Unless the user or your instructions say otherwise, save what');
    expect(text).toContain('about the user (preferences, working style');
    expect(text).toContain('about the project (decisions, conventions, goals');
    expect(text).toContain('about your own work (lessons on how to do it better)');
    expect(text).toContain('stable `key`');
    expect(text).toContain("Don't save what a doc already holds, passing details, or secrets");
    expect(text).toContain("A memory saved in a project's thread comes back in that project");
  });

  test('stays closed without it (memory_* alias ids do not reach agents)', async () => {
    expect((await textFor(['search'])) ?? '').not.toContain('## Memory');
    expect(await textFor(['memory_search'])).toBeNull();
  });
});

describe('perceptionBlock — Browser', () => {
  test('points web pages at the browser tool', async () => {
    const text = (await textFor(['browser'])) ?? '';
    expect(text).toContain('## Browser');
    expect(text).toContain('Use `browser` for web pages');
    expect(text).toContain('`handoff`');
    expect(text).toContain("open a page in the user's own browser only when they ask");
    // The safety rules every agent needs live once, in howToAct's ungated line.
    expect(text).not.toContain('sends, deletes or buys');
    expect(text).not.toContain('say what you are about to do');
  });

  test('leaves profiles, passwords and first-use consent to the browser tool description', async () => {
    const text = (await textFor(['browser'])) ?? '';
    expect(text).not.toContain('`temp` profile');
    expect(browserDefinition.description).toContain('"temp" = isolated, signed out');
    expect(browserDefinition.description).toContain('Never type passwords');
    expect(browserDefinition.description).toContain('The user is asked to allow first use');
    expect(browserDefinition.description).toContain('open(url) -> snapshot');
  });

  test('omits the section without the browser tool', async () => {
    expect((await textFor(['search'])) ?? '').not.toContain('## Browser');
  });
});

describe('perceptionBlock — Computer', () => {
  test('appears only when the agent holds the computer tool', async () => {
    const text = (await textFor(['computer'])) ?? '';
    expect(text).toContain('## Computer');
    expect(text).toContain('release the cursor as soon as you are done');
    expect(text).toContain('look (the accessibility tree) before you click');
    expect(text).toContain('Esc');
    // The safety rules every agent needs live once, in howToAct's ungated line.
    expect(text).not.toContain('sends, deletes or buys');
    expect(text).not.toContain('never take the mouse');
    expect(text).not.toContain('read on screen');
  });

  test('leaves claims, secrets and an interrupting user to the computer tool description', async () => {
    expect(computerDefinition.description).toContain(
      'Take the cursor (op:claim) only when you must'
    );
    expect(computerDefinition.description).toContain(
      'if it is busy, do other work and retry later'
    );
    expect(computerDefinition.description).toContain('Never type into password/secret fields');
    expect(computerDefinition.description).toContain('ask before taking it again');
    expect(computerDefinition.description).toContain('The user is asked to allow it first');
  });

  test('is absent without the tool', async () => {
    expect((await textFor(['search', 'browser'])) ?? '').not.toContain('## Computer');
  });
});
