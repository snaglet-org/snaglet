import {
  isValidLinkTriple,
  LINK_TYPE_MATRIX,
} from '../../../../packages/db/tables/links/linkTypeMatrix';

describe('linkTypeMatrix', () => {
  describe('isValidLinkTriple — happy paths', () => {
    test.each([
      ['doc', 'references', 'doc'],
      ['doc', 'references', 'thread'],
      ['doc', 'references', 'container'],
      ['doc', 'references', 'image'],
      // A `[label](message-…)` chip in a doc body cites one chat message.
      ['doc', 'references', 'message'],
      ['thread', 'references', 'doc'],
      ['thread_summary', 'summarizes', 'thread'],
      ['thread_summary', 'summarizes', 'message'],
      ['memory', 'summarizes', 'thread_summary'],
      ['memory', 'context', 'thread'],
      ['message', 'context', 'message'],
    ])('(%s, %s, %s) is valid', (src, rel, tgt) => {
      expect(isValidLinkTriple(src, rel, tgt)).toBe(true);
    });
  });

  describe('isValidLinkTriple — rejects', () => {
    test.each([
      // Wrong relation for source type
      ['doc', 'summarizes', 'thread'],
      ['doc', 'context', 'thread'],
      ['message', 'summarizes', 'thread'],
      // Wrong target for valid (source, relation)
      ['thread_summary', 'summarizes', 'doc'],
      ['memory', 'context', 'doc'],
      // Unknown relation
      ['doc', 'about', 'doc'],
      ['doc', 'authored_by', 'agent'],
      ['doc', 'similar', 'doc'],
      // Unknown source type
      ['run', 'references', 'doc'],
      // `sketch` is not a link source or target.
      ['doc', 'references', 'sketch'],
      ['thread', 'references', 'sketch'],
      ['memory', 'context', 'sketch'],
      // `post` is not a link source or target.
      ['doc', 'references', 'post'],
      ['thread', 'references', 'post'],
      ['post', 'references', 'doc'],
      ['post', 'references', 'post'],
      ['post', 'summarizes', 'thread'],
      ['memory', 'context', 'post'],
      // Only doc bodies cite a message; a thread never `references` one.
      ['thread', 'references', 'message'],
      ['message', 'references', 'doc'],
      // 'project' is a container category, not a node kind
      ['doc', 'references', 'project'],
      ['thread', 'context', 'project'],
      // 'task' is a Database table row (optionally linked to a doc), not a node kind
      ['doc', 'references', 'task'],
      ['task', 'context', 'thread'],
      ['task', 'references', 'doc'],
      // 'agent' is an actor, not a node kind, so memory→agent context links
      // do not exist.
      ['memory', 'context', 'agent'],
      // 'block' is not a node kind.
      ['doc', 'references', 'block'],
      ['block', 'references', 'block'],
      // Empty strings
      ['', 'references', 'doc'],
      ['doc', '', 'doc'],
      ['doc', 'references', ''],
    ])('(%s, %s, %s) is invalid', (src, rel, tgt) => {
      expect(isValidLinkTriple(src, rel, tgt)).toBe(false);
    });
  });

  test('matrix exports exactly the 3 canonical relations', () => {
    expect(Object.keys(LINK_TYPE_MATRIX).sort()).toEqual(['context', 'references', 'summarizes']);
  });
});
