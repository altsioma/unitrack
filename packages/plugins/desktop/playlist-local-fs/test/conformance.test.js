import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPlaylistProviderConformance } from '@unitrack/conformance-kit';
import { createLocalFolderPlaylistProvider } from '../src/index.js';

test('createLocalFolderPlaylistProvider() satisfies the PlaylistProvider contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unitrack-playlist-local-fs-conformance-'));
  try {
    await writeFile(join(dir, 'a.mp3'), '');
    const provider = createLocalFolderPlaylistProvider();
    await assertPlaylistProviderConformance(provider, { pluginId: provider.id, playlistId: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
