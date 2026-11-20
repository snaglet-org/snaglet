import { createHash } from 'node:crypto';
import type { TableField } from '@snaglet/shared/types';

/** Longest text of one cell that goes into a card; the rest is cut, never indexed. */
export const CARD_CELL_MAX_CHARS = 400;
/** Longest card. A row card is a summary of the row, not its contents. */
export const CARD_MAX_CHARS = 1500;

/** A word edge for names: not next to a letter, so `my_password` and `Passwords` both count. */
const word = (pattern: string) => `(?<![a-z])(?:${pattern})(?![a-z])`;

/**
 * Field names that look like secrets or payment and identity numbers. Such a
 * cell is left out of the card however it is typed, and the title is held to
 * the same rule: a vector of a password is still a copy of it. There is no
 * sensitive-field flag on tables, so the name is all there is to go on and
 * the match is best-effort (see the warning `setSemanticSearch` returns).
 *
 * Matches, case-insensitively, with plurals and `_`, `-` or space between
 * words: password(s), passphrase, passcode, passwd, secret, token, api key,
 * credential, private key, recovery code/key/phrase, backup code, seed phrase,
 * license key (either spelling), auth code, security question/answer, PIN, OTP, 2FA/MFA, CVV/CVC,
 * IBAN, SSN, social security, credit/debit card, bank account, and card /
 * account / routing / passport number. `secret` and `token` are substrings, so
 * a name like "Secretary" is over-excluded; that only costs a field.
 */
const SENSITIVE_NAME = new RegExp(
  [
    word('pass(?:words?|phrases?|codes?|wd)?'),
    'secret',
    'token',
    'credential',
    'api[\\s_-]?keys?',
    'private[\\s_-]?keys?',
    'recovery[\\s_-]?(?:codes?|keys?|phrases?)',
    'backup[\\s_-]?codes?',
    'seed[\\s_-]?phrase',
    'licen[cs]e[\\s_-]?key',
    'auth[\\s_-]?code',
    'security[\\s_-]?(?:questions?|answers?)',
    word('pins?|otps?|2fa|mfa|cvv|cvc|iban|ssn'),
    'social[\\s_-]?security',
    '(?:credit|debit)[\\s_-]?card',
    'bank[\\s_-]?account',
    '(?:card|account|routing|passport)[\\s_-]?(?:number|no|num)(?![a-z])',
  ].join('|'),
  'i'
);

export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}

/**
 * The fields a row card is made of, in card order: the title, then the prose
 * (text) fields, then the select fields. Numbers, dates, checkboxes,
 * relations and managed fields are not part of it; nor is a field named like
 * a secret, the title included.
 */
export function cardFields(fields: readonly TableField[]): TableField[] {
  const usable = fields.filter((field) => !field.managed && !isSensitiveFieldName(field.name));
  const title = usable.filter((field) => field.isTitle);
  const rest = usable.filter((field) => !field.isTitle);
  return [
    ...title,
    ...rest.filter((field) => field.type === 'text'),
    ...rest.filter((field) => field.type === 'select'),
  ];
}

function clean(value: unknown): string {
  const text = Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > CARD_CELL_MAX_CHARS ? `${flat.slice(0, CARD_CELL_MAX_CHARS)}…` : flat;
}

/**
 * One row's card: the table's name, then `Field: value` lines for its filled
 * title, text and select cells. Null when the row has none of them (nothing
 * to find it by), so it gets no vector.
 */
export function buildCard(
  tableName: string,
  fields: readonly TableField[],
  cells: Readonly<Record<string, unknown>>
): string | null {
  const lines: string[] = [];
  for (const field of cardFields(fields)) {
    const value = clean(cells[field.columnName]);
    if (value) lines.push(field.isTitle ? `Title: ${value}` : `${field.name}: ${value}`);
  }
  if (!lines.length) return null;
  const card = [`Table: ${tableName}`, ...lines].join('\n');
  return card.length > CARD_MAX_CHARS ? card.slice(0, CARD_MAX_CHARS) : card;
}

/** What identifies a vector's source: the model and the card. A change in either re-embeds the row. */
export function cardHash(modelId: string, card: string): string {
  return createHash('sha256').update(`${modelId}\n${card}`).digest('hex');
}
