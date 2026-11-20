/**
 * unwrapDoubleWrappedInput — pure-function contract.
 *
 * The lenient unwrap for the small-model "double-wrap" quirk
 * (`{ function_name: "create_doc", arguments: { … } }` sent AS the tool
 * input). Conservative by design: it must fire only on the exact wrapper
 * shape naming the invoked tool, and never touch anything that could be
 * legitimate input. See ToolExecutor.doubleWrapUnwrap.test.ts for wiring.
 */

import { unwrapDoubleWrappedInput } from '@server/services/ToolService/lib/unwrapDoubleWrappedInput';

const INVOKED = ['create_doc'];

describe('unwrapDoubleWrappedInput', () => {
  describe('exact-match unwraps', () => {
    it('unwraps { function_name, arguments } naming the invoked tool', () => {
      const inner = { title: 'Release notes', container_id: 'c1', content: 'body' };
      const result = unwrapDoubleWrappedInput(
        { function_name: 'create_doc', arguments: inner },
        INVOKED
      );
      expect(result).not.toBeNull();
      expect(result!.input).toBe(inner);
      expect(result!.nameKey).toBe('function_name');
      expect(result!.argsKey).toBe('arguments');
      expect(result!.wrapperToolName).toBe('create_doc');
    });

    it.each([
      ['name', 'args'],
      ['tool', 'parameters'],
      ['function_name', 'params' as string], // params is not an args key → no unwrap
    ])('wrapper keys %s + %s', (nameKey, argsKey) => {
      const input = { [nameKey]: 'create_doc', [argsKey]: { title: 'T' } };
      const result = unwrapDoubleWrappedInput(input, INVOKED);
      if (argsKey === 'params') {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
        expect(result!.input).toEqual({ title: 'T' });
      }
    });

    it('matches the tool name through snake_case normalization', () => {
      const result = unwrapDoubleWrappedInput(
        { function_name: 'createDoc', arguments: { title: 'T' } },
        INVOKED
      );
      expect(result).not.toBeNull();
    });

    it('matches any of the provided invoked-id candidates, ignoring undefined entries', () => {
      const result = unwrapDoubleWrappedInput(
        { function_name: 'create_doc', arguments: { title: 'T' } },
        ['workspace_create_doc', undefined, 'create_doc']
      );
      expect(result).not.toBeNull();
    });

    it('tolerates extra keys only when they are undefined-valued', () => {
      const result = unwrapDoubleWrappedInput(
        { function_name: 'create_doc', arguments: { title: 'T' }, stray: undefined },
        INVOKED
      );
      expect(result).not.toBeNull();
    });
  });

  describe('wrong tool name does not unwrap', () => {
    it('leaves a wrapper naming a different tool untouched', () => {
      expect(
        unwrapDoubleWrappedInput({ function_name: 'edit_doc', arguments: { title: 'T' } }, INVOKED)
      ).toBeNull();
    });

    it('leaves a non-string or empty wrapper name untouched', () => {
      expect(unwrapDoubleWrappedInput({ function_name: 7, arguments: {} }, INVOKED)).toBeNull();
      expect(unwrapDoubleWrappedInput({ function_name: '  ', arguments: {} }, INVOKED)).toBeNull();
    });
  });

  describe('tools with legitimately-named fields are unaffected', () => {
    it('never fires on a name-key alone (create_container creating a container named after itself)', () => {
      // create_container's own `name` param — even self-referential values
      // stay untouched without an object-valued args key beside them.
      expect(
        unwrapDoubleWrappedInput({ name: 'create_container' }, ['create_container'])
      ).toBeNull();
      expect(
        unwrapDoubleWrappedInput({ name: 'create_container', parent_id: 'c1' }, [
          'create_container',
        ])
      ).toBeNull();
    });

    it('never fires when other meaningful keys ride alongside the wrapper pair', () => {
      expect(
        unwrapDoubleWrappedInput(
          { function_name: 'create_doc', arguments: { title: 'T' }, title: 'Top-level' },
          INVOKED
        )
      ).toBeNull();
    });

    it('never fires when two name keys or two args keys are present', () => {
      expect(
        unwrapDoubleWrappedInput(
          { function_name: 'create_doc', tool: 'create_doc', arguments: { title: 'T' } },
          INVOKED
        )
      ).toBeNull();
      expect(
        unwrapDoubleWrappedInput(
          { function_name: 'create_doc', arguments: { title: 'T' }, args: { title: 'U' } },
          INVOKED
        )
      ).toBeNull();
    });

    it("action's legitimate { tool, params } dispatch shape is untouched when invoking action", () => {
      // `tool` names a different tool than the one invoked (`action`), and
      // `params` is not a wrapper args key anyway.
      expect(
        unwrapDoubleWrappedInput({ tool: 'file_read', params: { path: '/x' } }, ['action'])
      ).toBeNull();
    });
  });

  describe('non-object arguments are untouched', () => {
    it.each([
      ['JSON string', '{"title":"T"}'],
      ['array', [{ title: 'T' }]],
      ['null', null],
      ['number', 42],
    ])('%s', (_label, args) => {
      expect(
        unwrapDoubleWrappedInput({ function_name: 'create_doc', arguments: args }, INVOKED)
      ).toBeNull();
    });
  });
});
