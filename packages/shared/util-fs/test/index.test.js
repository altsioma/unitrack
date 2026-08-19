import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleFromFilename } from '../src/index.js';

test('titleFromFilename strips a simple extension', () => {
  assert.equal(titleFromFilename('/a/b/song.mp3'), 'song');
});

test('titleFromFilename returns the whole name when there is no extension', () => {
  assert.equal(titleFromFilename('/a/b/song'), 'song');
});

test('titleFromFilename strips only the last extension when the name has multiple dots', () => {
  assert.equal(titleFromFilename('/a/b/my.song.final.mp3'), 'my.song.final');
});

test('titleFromFilename treats a leading-dot filename as having no extension', () => {
  assert.equal(titleFromFilename('/a/b/.hidden'), '.hidden');
});

test('titleFromFilename ignores directory components', () => {
  assert.equal(titleFromFilename('/deeply/nested/path/track.flac'), 'track');
});
