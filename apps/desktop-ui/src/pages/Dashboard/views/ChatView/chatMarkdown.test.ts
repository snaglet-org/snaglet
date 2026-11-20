import { describe, expect, it } from 'vitest';
import {
  chatRenderOffsetToSource,
  markdownForChatMessageRender,
  normalizeChatComposerMarkdown,
} from './chatMarkdown';

describe('normalizeChatComposerMarkdown', () => {
  it('converts a single synthetic CommonMark hard-break marker into a chat newline', () => {
    expect(normalizeChatComposerMarkdown('line one\\\nline two')).toBe('line one\nline two');
  });

  it('converts multiple Shift+Enter hard breaks without adding visible backslashes', () => {
    expect(normalizeChatComposerMarkdown('one\\\ntwo\\\nthree')).toBe('one\ntwo\nthree');
  });

  it('preserves an intentional literal backslash before the chat newline', () => {
    expect(normalizeChatComposerMarkdown(`literal${'\\'.repeat(3)}\nnext`)).toBe(
      `literal${'\\'}\nnext`
    );
  });

  it('does not globally strip literal backslashes that are not hard-break markers', () => {
    expect(normalizeChatComposerMarkdown('C:\\Users\\User')).toBe('C:\\Users\\User');
  });

  it('preserves ordinary paragraph breaks', () => {
    expect(normalizeChatComposerMarkdown('first paragraph\n\nsecond paragraph')).toBe(
      'first paragraph\n\nsecond paragraph'
    );
  });
});

describe('markdownForChatMessageRender', () => {
  it('renders a chat newline as a Markdown hard line break without changing the wire bytes', () => {
    expect(markdownForChatMessageRender('line one\nline two')).toBe('line one  \nline two');
  });

  it('keeps paragraph breaks as paragraph breaks', () => {
    expect(markdownForChatMessageRender('first paragraph\n\nsecond paragraph')).toBe(
      'first paragraph\n\nsecond paragraph'
    );
  });

  it('preserves an intentional literal backslash before a rendered chat newline', () => {
    expect(markdownForChatMessageRender('literal\\\nnext')).toBe('literal\\  \nnext');
  });

  it('does not inject Markdown hard-break spaces inside fenced code blocks', () => {
    expect(markdownForChatMessageRender('```ts\nconst x = 1\nconst y = 2\n```\nafter')).toBe(
      '```ts\nconst x = 1\nconst y = 2\n```\nafter'
    );
  });
});

describe('chatRenderOffsetToSource', () => {
  const offsetsOf = (text: string, needle: string): [number, number] => {
    const rendered = markdownForChatMessageRender(text);
    return [rendered.indexOf(needle), text.indexOf(needle)];
  };

  it('maps each list item past the inserted hard-break spaces', () => {
    const text = '- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d';
    for (const item of ['- [ ] a', '- [ ] b', '- [ ] c', '- [ ] d']) {
      const [rendered, source] = offsetsOf(text, item);
      expect(chatRenderOffsetToSource(text, rendered)).toBe(source);
    }
  });

  it('maps across CRLF and lone CR line ends', () => {
    const text = 'intro\r\n- [ ] a\r- [ ] b';
    const [rendered, source] = offsetsOf(text, '- [ ] b');
    expect(chatRenderOffsetToSource(text, rendered)).toBe(source);
  });

  it('leaves offsets inside a fenced block and after blank lines aligned', () => {
    const text = 'one\n\n```\ncode\nmore\n```\n- [ ] after';
    const [rendered, source] = offsetsOf(text, '- [ ] after');
    expect(chatRenderOffsetToSource(text, rendered)).toBe(source);
  });
});
