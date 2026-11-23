import assert from 'node:assert/strict';
import test from 'node:test';
import {
  setCargoLockVersion,
  setCargoTomlVersion,
  setJsonVersion,
  versionFiles,
} from '../../scripts/release/set-version.mjs';
import { nextTag } from '../../scripts/release/tags.mjs';

test('main: the release tag is the source version', () => {
  assert.equal(nextTag({ branch: 'main', version: '1.0.1', tags: ['v1.0.0'] }).tag, 'v1.0.1');
});

test('main: beta tags of the same version do not block the release tag', () => {
  const tags = ['v1.0.0', 'v1.0.1-beta.1', 'v1.0.1-beta.2'];
  assert.equal(nextTag({ branch: 'main', version: '1.0.1', tags }).tag, 'v1.0.1');
});

test('main: a version that is already released asks for a bump', () => {
  const result = nextTag({ branch: 'main', version: '1.0.0', tags: ['v1.0.0'] });
  assert.equal(result.tag, null);
  assert.equal(result.bump, true);
});

test('main: a commit that already carries its release tag is left alone', () => {
  const result = nextTag({
    branch: 'main',
    version: '1.0.0',
    tags: ['v1.0.0'],
    headTags: ['v1.0.0'],
  });
  assert.equal(result.tag, null);
  assert.notEqual(result.bump, true);
});

test('staging: the first landing of a version is beta.1, then it counts up', () => {
  assert.equal(
    nextTag({ branch: 'staging', version: '1.0.1', tags: ['v1.0.0'] }).tag,
    'v1.0.1-beta.1'
  );
  const tags = ['v1.0.0', 'v1.0.1-beta.1', 'v1.0.1-beta.2', 'v1.0.1-beta.10', 'v1.0.0-beta.40'];
  assert.equal(nextTag({ branch: 'staging', version: '1.0.1', tags }).tag, 'v1.0.1-beta.11');
});

test('staging: a version that is already released asks for a bump', () => {
  const result = nextTag({ branch: 'staging', version: '1.0.0', tags: ['v1.0.0'] });
  assert.equal(result.tag, null);
  assert.equal(result.bump, true);
});

test('staging: a commit that already has a beta tag is left alone', () => {
  const result = nextTag({
    branch: 'staging',
    version: '1.0.1',
    tags: ['v1.0.1-beta.1'],
    headTags: ['v1.0.1-beta.1'],
  });
  assert.equal(result.tag, null);
  assert.notEqual(result.bump, true);
});

test('other branches and odd versions get no tag', () => {
  assert.equal(nextTag({ branch: 'fix/x', version: '1.0.1', tags: [] }).tag, null);
  assert.equal(nextTag({ branch: 'main', version: '1.0.1-rc.1', tags: [] }).tag, null);
});

test('the version is rewritten in each kind of file without touching the rest', () => {
  assert.equal(
    setJsonVersion(
      '{\n  "name": "x",\n  "version": "1.0.0",\n  "dependencies": { "a": "1.0.0" }\n}\n',
      '1.0.1'
    ),
    '{\n  "name": "x",\n  "version": "1.0.1",\n  "dependencies": { "a": "1.0.0" }\n}\n'
  );
  assert.equal(
    setCargoTomlVersion(
      '[package]\nname = "desktop"\nversion = "1.0.0"\n\n[dependencies]\nserde = { version = "1.0.0" }\n',
      '1.0.1'
    ),
    '[package]\nname = "desktop"\nversion = "1.0.1"\n\n[dependencies]\nserde = { version = "1.0.0" }\n'
  );
  const lock =
    '[[package]]\nname = "dep"\nversion = "1.0.0"\n\n[[package]]\nname = "desktop"\nversion = "1.0.0"\n';
  assert.equal(
    setCargoLockVersion(lock, 'desktop', '1.0.1'),
    '[[package]]\nname = "dep"\nversion = "1.0.0"\n\n[[package]]\nname = "desktop"\nversion = "1.0.1"\n'
  );
});

test('the version files include the root, the apps and the Tauri config', () => {
  const files = versionFiles();
  for (const file of [
    'package.json',
    'apps/desktop/package.json',
    'apps/desktop/src-tauri/tauri.conf.json',
  ]) {
    assert.ok(files.includes(file), file);
  }
});
