/**
 * convertFileToDoc — drop-to-doc conversion rules: plain text passes
 * through, data formats get fenced, PDFs go through the shared
 * pdfTextExtraction helper (exercised here against real in-memory PDFs),
 * binary-masquerading text and unknown extensions reject.
 */

import { convertFileToDoc } from '@server/domains/docs/docImport';
import { buildMinimalPdf } from '../../../../../support/minimalPdf';

describe('convertFileToDoc', () => {
  test('markdown imports as-is with the extension stripped from the title', async () => {
    const result = await convertFileToDoc('Meeting Notes.md', Buffer.from('# Agenda\n- item\n'));
    expect(result.title).toBe('Meeting Notes');
    expect(result.content).toBe('# Agenda\n- item');
  });

  test('plain text imports as-is', async () => {
    const result = await convertFileToDoc('todo.txt', Buffer.from('buy milk\n'));
    expect(result).toEqual({ title: 'todo', content: 'buy milk' });
  });

  test('json is fenced and the title keeps the extension (data formats)', async () => {
    const result = await convertFileToDoc('config.json', Buffer.from('{"a":1}'));
    expect(result.title).toBe('config.json');
    expect(result.content).toBe('```json\n{"a":1}\n```');
  });

  test('yaml fence uses the yaml language tag for .yml too', async () => {
    const result = await convertFileToDoc('ci.yml', Buffer.from('on: push'));
    expect(result.title).toBe('ci.yml');
    expect(result.content).toBe('```yaml\non: push\n```');
  });

  test('log files keep the extension in the title too', async () => {
    const result = await convertFileToDoc('server.log', Buffer.from('boot ok'));
    expect(result.title).toBe('server.log');
    expect(result.content).toBe('boot ok');
  });

  test('pdf extracts text (real parse), extension stripped from the title', async () => {
    const pdf = buildMinimalPdf(['extracted body', 'second page']);
    const result = await convertFileToDoc('report.pdf', pdf);
    expect(result.title).toBe('report');
    expect(result.content).toContain('extracted body');
    expect(result.content).toContain('second page');
  });

  test('image-only pdf (no extractable text) rejects with a clear error', async () => {
    await expect(convertFileToDoc('scan.pdf', buildMinimalPdf([null]))).rejects.toThrow(
      /no extractable text/
    );
  });

  test('corrupt pdf rejects with a could-not-read error', async () => {
    await expect(convertFileToDoc('broken.pdf', Buffer.from('%PDF-not-really'))).rejects.toThrow(
      /Could not read "broken\.pdf" as a PDF/
    );
  });

  test('binary payload wearing a text extension rejects', async () => {
    await expect(
      convertFileToDoc('fake.txt', Buffer.from([0x68, 0x69, 0x00, 0x68]))
    ).rejects.toThrow(/binary data/);
  });

  test('unsupported extension rejects and lists the supported set', async () => {
    await expect(convertFileToDoc('archive.zip', Buffer.from('PK'))).rejects.toThrow(
      /Unsupported file type "\.zip"/
    );
  });

  test('dotfiles have no extension (Node path.extname semantics) and reject', async () => {
    await expect(convertFileToDoc('.md', Buffer.from('x'))).rejects.toThrow(
      /Unsupported file type "\(none\)"/
    );
  });
});
