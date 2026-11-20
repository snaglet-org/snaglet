/**
 * nlpProtocol — pure framing/parsing unit tests, independent of any spawned
 * process. Proves the request frame is byte-exact and that the response line
 * parser handles chunk boundaries, malformed lines, and multiple lines in one
 * chunk (the same properties appleSttProtocol.test.ts would assert for the
 * STT sidecar's wire contract).
 */

import { describe, expect, it } from '@jest/globals';
import {
  createRequestFrameParser,
  createResponseLineParser,
  encodeRequestFrame,
} from '@server/services/nlp/nlpProtocol';

describe('encodeRequestFrame', () => {
  it('encodes a 4-byte BE length header followed by the UTF-8 payload', () => {
    const frame = encodeRequestFrame('hi');
    expect(frame.length).toBe(4 + 2);
    expect(frame.readUInt32BE(0)).toBe(2);
    expect(frame.subarray(4).toString('utf8')).toBe('hi');
  });

  it('uses the UTF-8 byte length, not the JS string length (multi-byte chars)', () => {
    const text = '日本語'; // 3 chars, 9 UTF-8 bytes
    const frame = encodeRequestFrame(text);
    expect(frame.readUInt32BE(0)).toBe(Buffer.byteLength(text, 'utf8'));
    expect(frame.subarray(4).toString('utf8')).toBe(text);
  });

  it('round-trips embedded newlines through the frame parser unmodified', () => {
    const text = 'line one\nline two\nline three';
    const frame = encodeRequestFrame(text);
    const seen: string[] = [];
    const parse = createRequestFrameParser((t) => seen.push(t));
    parse(frame);
    expect(seen).toEqual([text]);
  });
});

describe('createRequestFrameParser', () => {
  it('parses a frame split across multiple chunks', () => {
    const frame = encodeRequestFrame('hello world');
    const seen: string[] = [];
    const parse = createRequestFrameParser((t) => seen.push(t));
    parse(frame.subarray(0, 3));
    parse(frame.subarray(3, 7));
    parse(frame.subarray(7));
    expect(seen).toEqual(['hello world']);
  });

  it('parses multiple frames arriving in one chunk', () => {
    const frames = Buffer.concat([encodeRequestFrame('a'), encodeRequestFrame('bb')]);
    const seen: string[] = [];
    const parse = createRequestFrameParser((t) => seen.push(t));
    parse(frames);
    expect(seen).toEqual(['a', 'bb']);
  });
});

describe('createResponseLineParser', () => {
  it('parses one JSON line into a response object', () => {
    const seen: unknown[] = [];
    const parse = createResponseLineParser((l) => seen.push(l));
    parse(Buffer.from('{"entities":["A"],"language":"en"}\n'));
    expect(seen).toEqual([{ entities: ['A'], language: 'en' }]);
  });

  it('buffers a partial line across chunk boundaries', () => {
    const seen: unknown[] = [];
    const parse = createResponseLineParser((l) => seen.push(l));
    parse(Buffer.from('{"entities":[],"lang'));
    parse(Buffer.from('uage":null}\n'));
    expect(seen).toEqual([{ entities: [], language: null }]);
  });

  it('parses multiple lines delivered in one chunk, in order', () => {
    const seen: unknown[] = [];
    const parse = createResponseLineParser((l) => seen.push(l));
    parse(Buffer.from('{"entities":["A"],"language":"en"}\n{"entities":["B"],"language":"fr"}\n'));
    expect(seen).toEqual([
      { entities: ['A'], language: 'en' },
      { entities: ['B'], language: 'fr' },
    ]);
  });

  it('drops a malformed line rather than throwing', () => {
    const seen: unknown[] = [];
    const parse = createResponseLineParser((l) => seen.push(l));
    expect(() =>
      parse(Buffer.from('not json at all\n{"entities":["ok"],"language":null}\n'))
    ).not.toThrow();
    expect(seen).toEqual([{ entities: ['ok'], language: null }]);
  });

  it('drops a well-formed JSON line missing the expected shape', () => {
    const seen: unknown[] = [];
    const parse = createResponseLineParser((l) => seen.push(l));
    parse(Buffer.from('{"foo":"bar"}\n{"entities":["ok"],"language":null}\n'));
    expect(seen).toEqual([{ entities: ['ok'], language: null }]);
  });
});
