/** The row card a vector is made from, its hash, and the size estimate of an index. */
import { describe, expect, it } from '@jest/globals';
import type { TableField } from '@snaglet/shared/types';
import {
  buildCard,
  cardFields,
  cardHash,
  CARD_CELL_MAX_CHARS,
  CARD_MAX_CHARS,
  isSensitiveFieldName,
} from '@server/services/tableSemantic/rowCard';
import {
  estimateSemanticSize,
  SEMANTIC_BYTES_PER_ROW,
  SEMANTIC_ROW_CAP,
} from '@server/services/tableSemantic/sizeEstimate';
import { fuseRankings } from '@server/services/search/entryFusion';

function field(name: string, extra: Partial<TableField> = {}): TableField {
  return {
    id: `f-${name}`,
    tableId: 't',
    columnName: `f_${name.replace(/\W/g, '_')}`,
    name,
    type: 'text',
    managed: false,
    isTitle: false,
    multiple: false,
    options: null,
    ...extra,
  } as unknown as TableField;
}

const FIELDS = [
  field('created_at', { managed: true, type: 'datetime' as never }),
  field('Summary', { isTitle: true }),
  field('Notes'),
  field('Status', { type: 'select' as never }),
  field('Estimate', { type: 'number' as never }),
  field('Due', { type: 'date' as never }),
  field('Owner link', { type: 'relation' as never }),
  field('API key'),
  field('Password hint'),
];

describe('row card', () => {
  it('is made of the title, prose and select cells only, in that order', () => {
    expect(cardFields(FIELDS).map((item) => item.name)).toEqual(['Summary', 'Notes', 'Status']);
  });

  it('leaves out fields named like secrets, plurals and multi-word names included', () => {
    const secret = [
      'API key',
      'api_key',
      'API keys',
      'apiKey',
      'Password',
      'Passwords',
      'Login passwords',
      'my_password',
      'Passphrase',
      'Passcode',
      'Client secret',
      'Auth token',
      'Tokens',
      'SSN',
      'Social security number',
      'Credit card',
      'Card number',
      'Bank account',
      'Account number',
      'Routing number',
      'PIN',
      'Pins',
      'OTP',
      'Recovery codes',
      'Backup codes',
      '2FA code',
      'MFA secret',
      'CVV',
      'IBAN',
      'Seed phrase',
      'License key',
      'Security answer',
      'Private key',
      'Credentials',
      'Licence key',
      'Passport number',
    ];
    for (const name of secret) expect([name, isSensitiveFieldName(name)]).toEqual([name, true]);
    const fine = [
      'Notes',
      'Passenger',
      'Passes',
      'Description',
      'Status',
      'Spinning',
      'Potpourri',
      'Pinned',
      'Pinterest',
      'Account manager',
      'Account',
      'Card design',
      'Routing rules',
      'Recovery plan',
      'Bypass',
      'Summary',
    ];
    for (const name of fine) expect([name, isSensitiveFieldName(name)]).toEqual([name, false]);
  });

  it('holds the title to the same rule: a secret-named title field is not embedded', () => {
    const fields = [field('Password', { isTitle: true }), field('Notes')];
    expect(cardFields(fields).map((item) => item.name)).toEqual(['Notes']);
    expect(buildCard('T', fields, { f_Password: 'hunter2', f_Notes: 'hello' })).toBe(
      'Table: T\nNotes: hello'
    );
    expect(buildCard('T', fields, { f_Password: 'hunter2' })).toBeNull();
  });

  it('keeps secret cells out of the card of a normal row', () => {
    const cells = { f_Summary: 'Reset', f_API_key: 'sk-live-123', f_Password_hint: 'dog name' };
    expect(buildCard('Tasks', FIELDS, cells)).toBe('Table: Tasks\nTitle: Reset');
  });

  it('writes the table name, then Title and Field: value lines for filled cells', () => {
    const card = buildCard('Tasks', FIELDS, {
      f_Summary: 'Fix memories cleanup',
      f_Notes: '  prune\nold   rows ',
      f_Status: 'doing',
      f_Estimate: '8',
    });
    expect(card).toBe(
      'Table: Tasks\nTitle: Fix memories cleanup\nNotes: prune old rows\nStatus: doing'
    );
  });

  it('joins a multi select, and has no card for a row with nothing filled in', () => {
    const multi = [
      field('Title', { isTitle: true }),
      field('Tags', { type: 'select' as never, multiple: true }),
    ];
    expect(buildCard('T', multi, { f_Title: 'x', f_Tags: ['a', 'b'] })).toContain('Tags: a, b');
    expect(
      buildCard('Tasks', FIELDS, { f_Summary: '', f_Notes: null, f_Status: '   ' })
    ).toBeNull();
  });

  it('cuts a long cell and keeps the whole card bounded: bulk content never goes in', () => {
    const long = 'word '.repeat(500);
    const card = buildCard('Tasks', FIELDS, { f_Summary: 'T', f_Notes: long })!;
    expect(card.length).toBeLessThanOrEqual(CARD_MAX_CHARS);
    const notes = card.split('\n').find((line) => line.startsWith('Notes: '))!;
    expect(notes.length).toBeLessThanOrEqual('Notes: '.length + CARD_CELL_MAX_CHARS + 1);
    expect(notes.endsWith('…')).toBe(true);
  });

  it('hashes the card with the model: either changing makes a row re-embed', () => {
    expect(cardHash('m1', 'Table: T\nTitle: a')).toBe(cardHash('m1', 'Table: T\nTitle: a'));
    expect(cardHash('m1', 'Table: T\nTitle: a')).not.toBe(cardHash('m1', 'Table: T\nTitle: b'));
    expect(cardHash('m1', 'Table: T\nTitle: a')).not.toBe(cardHash('m2', 'Table: T\nTitle: a'));
  });
});

describe('size estimate', () => {
  it('is about 4.4 KB a row, in a number a person can read', () => {
    expect(SEMANTIC_BYTES_PER_ROW).toBeGreaterThan(4 * 1024);
    expect(estimateSemanticSize(0).label).toBe('~1 KB');
    expect(estimateSemanticSize(100).label).toBe('~430 KB');
    expect(estimateSemanticSize(1000).label).toBe('~4.2 MB');
    expect(estimateSemanticSize(SEMANTIC_ROW_CAP).label).toBe('~42 MB');
    expect(estimateSemanticSize(50_000).label).toBe('~210 MB');
  });
});

describe('fuseRankings', () => {
  it('lifts a row both lists have, and labels where each came from', () => {
    const fused = fuseRankings(['a', 'b', 'c'], ['x', 'c', 'a'], 'hybrid');
    expect(fused.map((item) => item.key)).toEqual(['a', 'c', 'x', 'b']);
    expect(Object.fromEntries(fused.map((item) => [item.key, item.match]))).toEqual({
      a: 'both',
      c: 'both',
      b: 'keyword',
      x: 'meaning',
    });
  });

  it('keyword-only when there is no meaning hit, even in semantic mode', () => {
    expect(fuseRankings(['a', 'b'], [], 'semantic').map((item) => item.key)).toEqual(['a', 'b']);
    expect(fuseRankings(['a', 'b'], ['b', 'x'], 'semantic').map((item) => item.key)).toEqual([
      'b',
      'x',
    ]);
  });
});
