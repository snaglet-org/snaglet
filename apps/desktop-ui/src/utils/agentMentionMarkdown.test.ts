import { describe, expect, it } from 'vitest';

import { appendSelectedAgentMentions } from './agentMentionMarkdown';

const venus = { id: 'agent-venus', name: 'Venus' };
const clio = { id: 'agent-clio', name: 'Clio' };

describe('appendSelectedAgentMentions', () => {
  it('appends selected agents using mention markdown', () => {
    expect(appendSelectedAgentMentions('Hello', [venus, clio])).toBe('Hello @Venus @Clio');
  });

  it('deduplicates selected IDs and existing mentions', () => {
    expect(appendSelectedAgentMentions('Hello @Venus', [venus, venus, clio, clio])).toBe(
      'Hello @Venus @Clio'
    );
  });

  it('leaves text unchanged when selection is empty', () => {
    expect(appendSelectedAgentMentions('Hello', [])).toBe('Hello');
  });

  it('does not add a leading space to empty text', () => {
    expect(appendSelectedAgentMentions('', [venus])).toBe('@Venus');
  });
});
