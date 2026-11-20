import { describe, expect, it } from '@jest/globals';
import { isConversationCompactionEnabled } from '@server/config/conversationCompactionPolicy';

describe('conversationCompactionPolicy', () => {
  it.each([undefined, '', 'true', 'TRUE', '1', 'yes'])(
    'preserves the enabled default for %p',
    (value) => {
      const env = value === undefined ? {} : { COMPACT_CONVERSATIONS: value };
      expect(isConversationCompactionEnabled(env)).toBe(true);
    }
  );

  it.each(['false', 'FALSE', ' false '])('hard-disables generation for %p', (value) => {
    expect(isConversationCompactionEnabled({ COMPACT_CONVERSATIONS: value })).toBe(false);
  });
});
