import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalFileMetadataProvider } from '../src/index.js';

// import.meta.dirname (Node >=20.11/21.2) is safe here — this package's own
// engines floor is Node >=22.
const FIXTURES = join(import.meta.dirname, 'fixtures');

/**
 * @param {string} file
 * @returns {Promise<import('@unitrack/core/types').TrackMetadata>}
 */
function fetchFixture(file) {
  const provider = createLocalFileMetadataProvider();
  const path = join(FIXTURES, file);
  return provider.fetchForSource({
    pluginId: 'local-fs', token: { pluginId: 'local-fs', token: path }, kind: 'local',
  });
}

test('fetchForSource reads artist/album/title from a tagged mp3', async () => {
  const metadata = await fetchFixture('sample.mp3');
  assert.equal(metadata.artist, 'Test Artist');
  assert.equal(metadata.album, 'Test Album');
  assert.equal(metadata.title, 'Test Title');
});

for (const file of ['sample.wav', 'sample.ogg', 'sample.flac', 'sample.m4a']) {
  test(`fetchForSource reads artist/album/title from a tagged ${file}`, async () => {
    const metadata = await fetchFixture(file);
    assert.equal(metadata.artist, 'Test Artist');
    assert.equal(metadata.album, 'Test Album');
    assert.equal(metadata.title, 'Test Title');
  });
}

// sample.aac is deliberately NOT tagged, unlike every other fixture format
// above. Confirmed empirically (ffmpeg -metadata + music-metadata's own
// parseFile against the result): a raw ADTS AAC stream has no container
// field for artist/album/title metadata at all — ffmpeg's encode log claims
// to write it, but nothing is actually embedded, and music-metadata reads
// back artist/album/title as all `undefined`. So there is no tagged-AAC
// fixture to test against; sample.aac instead exercises the untagged/
// filename-fallback path below, which is the one real, testable AAC
// behaviour this provider has.
test('fetchForSource on an untagged file falls back to a filename-derived title', async () => {
  const metadata = await fetchFixture('sample.aac');
  assert.equal(metadata.artist, '');
  assert.equal(metadata.album, '');
  assert.equal(metadata.title, 'sample');
});

test('fetchForSource returns a coverArtUrl data: URL for a fixture with embedded art', async () => {
  const metadata = await fetchFixture('sample.mp3');
  assert.ok(metadata.coverArtUrl?.startsWith('data:image/jpeg;base64,'));
  const base64 = metadata.coverArtUrl.slice('data:image/jpeg;base64,'.length);
  const decoded = Buffer.from(base64, 'base64');
  assert.ok(decoded.length > 0);
  // A JPEG file starts with the SOI marker 0xFFD8.
  assert.equal(decoded[0], 0xff);
  assert.equal(decoded[1], 0xd8);
});

test('fetchForSource returns a duration close to the fixture\'s real ~1 second length', async () => {
  const metadata = await fetchFixture('sample.mp3');
  assert.ok(metadata.duration !== undefined);
  assert.ok(Math.abs(metadata.duration - 1) < 0.2, `expected ~1s, got ${metadata.duration}`);
});

test('fetchForSource rejects when the file does not exist', async () => {
  await assert.rejects(() => fetchFixture('does-not-exist.mp3'));
});

test('fetchForSource rejects when the file is not a recognizable audio format', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'metadata-local-fs-'));
  try {
    const filePath = join(dir, 'notes.txt');
    await writeFile(filePath, 'this is plainly not an audio file');
    const provider = createLocalFileMetadataProvider();
    await assert.rejects(() =>
      provider.fetchForSource({ pluginId: 'local-fs', token: { pluginId: 'local-fs', token: filePath }, kind: 'local' })
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('search() always rejects with the documented "not supported" message', async () => {
  const provider = createLocalFileMetadataProvider();
  await assert.rejects(
    () => provider.search({ artist: 'Test Artist' }),
    /search\(\) is not supported by @unitrack\/metadata-local-fs/
  );
});

test('initialize and dispose resolve without throwing', async () => {
  const provider = createLocalFileMetadataProvider();
  await provider.initialize({});
  await provider.dispose();
});
