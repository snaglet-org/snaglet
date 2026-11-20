import { readFile } from 'node:fs/promises';
import { safeJsonParse } from '@snaglet/shared/utils';

interface BertTokenizerConfig {
  do_lower_case?: boolean;
  strip_accents?: boolean | null;
  model_max_length?: number;
}

export interface PairEncoding {
  inputIds: number[];
  attentionMask: number[];
  tokenTypeIds: number[];
}

const PAD_TOKEN = '[PAD]';
const UNK_TOKEN = '[UNK]';
const CLS_TOKEN = '[CLS]';
const SEP_TOKEN = '[SEP]';

const DEFAULT_MAX_INPUT_CHARS_PER_WORD = 100;

function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code <= 31 || code === 127) && !isWhitespace(char);
}

function isPunctuation(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126) ||
    /\p{P}/u.test(char)
  );
}

function stripAccents(input: string): string {
  return input.normalize('NFD').replace(/\p{Mn}/gu, '');
}

function basicTokenize(input: string, config: BertTokenizerConfig): string[] {
  const out: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (current) {
      out.push(current);
      current = '';
    }
  };

  for (const char of input) {
    if (isControl(char)) continue;
    if (isWhitespace(char)) {
      pushCurrent();
      continue;
    }
    if (isPunctuation(char)) {
      pushCurrent();
      out.push(char);
      continue;
    }
    current += char;
  }
  pushCurrent();

  return out.map((token) => {
    let normalized = config.do_lower_case === false ? token : token.toLowerCase();
    if (config.strip_accents === true || config.do_lower_case !== false) {
      normalized = stripAccents(normalized);
    }
    return normalized;
  });
}

function truncatePair(a: string[], b: string[], maxTokens: number): void {
  while (a.length + b.length > maxTokens) {
    if (b.length > a.length) b.pop();
    else a.pop();
  }
}

export class WordPieceTokenizer {
  private readonly padId: number;
  private readonly unkId: number;
  private readonly clsId: number;
  private readonly sepId: number;

  constructor(
    private readonly vocab: Map<string, number>,
    private readonly config: BertTokenizerConfig = {}
  ) {
    this.padId = this.requireToken(PAD_TOKEN);
    this.unkId = this.requireToken(UNK_TOKEN);
    this.clsId = this.requireToken(CLS_TOKEN);
    this.sepId = this.requireToken(SEP_TOKEN);
  }

  static async fromFiles(
    vocabFile: string,
    tokenizerConfigFile?: string
  ): Promise<WordPieceTokenizer> {
    const [vocabText, configText] = await Promise.all([
      readFile(vocabFile, 'utf8'),
      tokenizerConfigFile ? readFile(tokenizerConfigFile, 'utf8').catch(() => '{}') : '{}',
    ]);

    const vocab = new Map<string, number>();
    vocabText.split(/\r?\n/u).forEach((token, index) => {
      if (token) vocab.set(token, index);
    });

    const config = safeJsonParse<BertTokenizerConfig>(configText, {});

    return new WordPieceTokenizer(vocab, config);
  }

  encodePair(query: string, passage: string, maxSequenceTokens: number): PairEncoding {
    if (maxSequenceTokens < 4) {
      throw new Error('maxSequenceTokens must be at least 4 for pair encoding');
    }

    const queryTokens = this.tokenize(query);
    const passageTokens = this.tokenize(passage);
    truncatePair(queryTokens, passageTokens, maxSequenceTokens - 3);

    const tokens = [CLS_TOKEN, ...queryTokens, SEP_TOKEN, ...passageTokens, SEP_TOKEN];
    const inputIds = tokens.map((token) => this.vocab.get(token) ?? this.unkId);
    const firstSegmentLength = queryTokens.length + 2;
    const tokenTypeIds = tokens.map((_, index) => (index < firstSegmentLength ? 0 : 1));
    const attentionMask = new Array<number>(inputIds.length).fill(1);

    return { inputIds, attentionMask, tokenTypeIds };
  }

  /**
   * Single-sequence encoding for bi-encoder embedding models (e.g. nomic-embed).
   * Produces `[CLS] tokens [SEP]` with a single segment (all tokenTypeIds = 0),
   * truncating the body to fit `maxSequenceTokens` (reserving 2 slots for the
   * CLS/SEP specials). Mirrors HuggingFace BERT single-sequence encoding.
   */
  encodeSingle(text: string, maxSequenceTokens: number): PairEncoding {
    if (maxSequenceTokens < 2) {
      throw new Error('maxSequenceTokens must be at least 2 for single encoding');
    }

    const bodyTokens = this.tokenize(text);
    const maxBody = maxSequenceTokens - 2;
    if (bodyTokens.length > maxBody) bodyTokens.length = maxBody;

    const tokens = [CLS_TOKEN, ...bodyTokens, SEP_TOKEN];
    const inputIds = tokens.map((token) => this.vocab.get(token) ?? this.unkId);
    const tokenTypeIds = new Array<number>(inputIds.length).fill(0);
    const attentionMask = new Array<number>(inputIds.length).fill(1);

    return { inputIds, attentionMask, tokenTypeIds };
  }

  get padTokenId(): number {
    return this.padId;
  }

  private tokenize(input: string): string[] {
    const output: string[] = [];
    for (const token of basicTokenize(input, this.config)) {
      output.push(...this.wordPiece(token));
    }
    return output;
  }

  private wordPiece(token: string): string[] {
    if (token.length > DEFAULT_MAX_INPUT_CHARS_PER_WORD) return [UNK_TOKEN];

    const pieces: string[] = [];
    let start = 0;
    while (start < token.length) {
      let end = token.length;
      let current: string | null = null;
      while (start < end) {
        const slice = token.slice(start, end);
        const candidate = start === 0 ? slice : `##${slice}`;
        if (this.vocab.has(candidate)) {
          current = candidate;
          break;
        }
        end -= 1;
      }

      if (!current) return [UNK_TOKEN];
      pieces.push(current);
      start = end;
    }

    return pieces;
  }

  private requireToken(token: string): number {
    const id = this.vocab.get(token);
    if (id == null) throw new Error(`Tokenizer vocabulary is missing ${token}`);
    return id;
  }
}
