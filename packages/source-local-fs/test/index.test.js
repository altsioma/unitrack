import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalFileSourceProvider } from '../src/index.js';

test('has the local-fs id and kind', () => {
  const provider = createLocalFileSourceProvider();
  assert.equal(provider.id, 'local-fs');
  assert.equal(provider.kind, 'local');
});

test('canResolve returns true only for refs targeting this plugin', () => {
  const provider = createLocalFileSourceProvider();
  assert.equal(provider.canResolve({ pluginId: 'local-fs', sourceId: '/x', kind: 'local' }), true);
  assert.equal(provider.canResolve({ pluginId: 'spotify', sourceId: '/x', kind: 'streaming' }), false);
});

test('resolve returns a file:// URL and the format from the extension for an existing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unitrack-source-local-fs-'));
  const filePath = join(dir, 'song.flac');
  await writeFile(filePath, 'not real audio, just bytes');
  try {
    const provider = createLocalFileSourceProvider();
    const resolved = await provider.resolve({ pluginId: 'local-fs', sourceId: filePath, kind: 'local' });
    assert.deepEqual(resolved, { url: pathToFileURL(filePath).href, format: 'flac' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve omits format for a file with no extension', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unitrack-source-local-fs-'));
  const filePath = join(dir, 'noext');
  await writeFile(filePath, 'not real audio, just bytes');
  try {
    const provider = createLocalFileSourceProvider();
    const resolved = await provider.resolve({ pluginId: 'local-fs', sourceId: filePath, kind: 'local' });
    assert.deepEqual(resolved, { url: pathToFileURL(filePath).href });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve rejects for a nonexistent path', async () => {
  const provider = createLocalFileSourceProvider();
  await assert.rejects(
    () => provider.resolve({ pluginId: 'local-fs', sourceId: '/definitely/does/not/exist.mp3', kind: 'local' }),
    (err) => {
      assert.ok(err instanceof Error);
      return true;
    }
  );
});
