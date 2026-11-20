import { describe, expect, it } from 'vitest';
import {
  filePathToChipHref,
  folderPathToChipHref,
  parseFilePathChipHref,
  parseFolderPathChipHref,
} from './filePath';

describe('file and folder chip hrefs', () => {
  it.each(['/projects/example/episodes/show.mp3', '/projects/example/Morning show #1.mp3'])(
    'round-trips the absolute path %s',
    (path) => {
      expect(parseFilePathChipHref(filePathToChipHref(path))).toBe(path);
      expect(parseFolderPathChipHref(folderPathToChipHref(path))).toBe(path);
    }
  );

  it.each([
    ['a URL authority', 'file://host/x'],
    ['a percent-encoded authority', 'file:%2F%2Fhost/x'],
    ['a mixed-encoded authority', 'file:/%2Fhost/x'],
    ['an empty path', 'file:'],
    ['a malformed escape', 'file:/projects/%E0%A4%A'],
    ['another scheme', 'folder:/projects/example'],
  ])('refuses %s as a file chip', (_label, href) => {
    expect(parseFilePathChipHref(href)).toBeNull();
  });

  it('refuses a percent-encoded authority as a folder chip too', () => {
    expect(parseFolderPathChipHref('folder:%2F%2Fhost/x')).toBeNull();
  });
});
