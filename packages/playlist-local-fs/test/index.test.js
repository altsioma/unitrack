import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalFolderPlaylistProvider } from '../src/index.js';

/** @returns {Promise<string>} */
async function makeTempDir() {
  return mkdtemp(join(tmpdir(), 'playlist-local-fs-'));
}

test('a flat directory of audio files returns one correctly-shaped LogicalTrack per file', async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, 'a.mp3'), '');
    await writeFile(join(dir, 'b.flac'), '');
    const provider = createLocalFolderPlaylistProvider();
    const tracks = await provider.fetchPlaylist({ pluginId: provider.id, playlistId: dir });
    assert.deepEqual(tracks, [
      {
        id: join(dir, 'a.mp3'),
        metadata: { artist: '', album: '', title: 'a' },
        sources: [{ pluginId: 'local-fs', sourceId: join(dir, 'a.mp3'), kind: 'local' }],
      },
      {
        id: join(dir, 'b.flac'),
        metadata: { artist: '', album: '', title: 'b' },
        sources: [{ pluginId: 'local-fs', sourceId: join(dir, 'b.flac'), kind: 'local' }],
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-audio files are excluded', async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, 'song.mp3'), '');
    await writeFile(join(dir, 'cover.jpg'), '');
    await writeFile(join(dir, 'notes.txt'), '');
    const provider = createLocalFolderPlaylistProvider();
    const tracks = await provider.fetchPlaylist({ pluginId: provider.id, playlistId: dir });
    assert.deepEqual(tracks.map((t) => t.id), [join(dir, 'song.mp3')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recursive mode (default) includes files nested in subdirectories', async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, 'Album'));
    await writeFile(join(dir, 'top.mp3'), '');
    await writeFile(join(dir, 'Album', 'nested.mp3'), '');
    const provider = createLocalFolderPlaylistProvider();
    const tracks = await provider.fetchPlaylist({ pluginId: provider.id, playlistId: dir });
    assert.deepEqual(
      tracks.map((t) => t.id).sort(),
      [join(dir, 'Album', 'nested.mp3'), join(dir, 'top.mp3')].sort()
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recursive: false only scans the top level', async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, 'Album'));
    await writeFile(join(dir, 'top.mp3'), '');
    await writeFile(join(dir, 'Album', 'nested.mp3'), '');
    const provider = createLocalFolderPlaylistProvider({ recursive: false });
    const tracks = await provider.fetchPlaylist({ pluginId: provider.id, playlistId: dir });
    assert.deepEqual(tracks.map((t) => t.id), [join(dir, 'top.mp3')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extension matching is case-insensitive', async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, 'song.MP3'), '');
    const provider = createLocalFolderPlaylistProvider();
    const tracks = await provider.fetchPlaylist({ pluginId: provider.id, playlistId: dir });
    assert.deepEqual(tracks.map((t) => t.id), [join(dir, 'song.MP3')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dotfiles and dot-directories are skipped', async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, '.hidden-dir'));
    await writeFile(join(dir, '.hidden.mp3'), '');
    await writeFile(join(dir, '.hidden-dir', 'inside.mp3'), '');
    await writeFile(join(dir, 'visible.mp3'), '');
    const provider = createLocalFolderPlaylistProvider();
    const tracks = await provider.fetchPlaylist({ pluginId: provider.id, playlistId: dir });
    assert.deepEqual(tracks.map((t) => t.id), [join(dir, 'visible.mp3')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('symlinked files and directories are not followed', async () => {
  const dir = await makeTempDir();
  const realDir = await makeTempDir();
  try {
    await writeFile(join(dir, 'real-file.mp3'), '');
    await writeFile(join(realDir, 'real.mp3'), '');
    await symlink(join(dir, 'real-file.mp3'), join(dir, 'link.mp3'));
    await symlink(realDir, join(dir, 'link-dir'));
    const provider = createLocalFolderPlaylistProvider();
    const tracks = await provider.fetchPlaylist({ pluginId: provider.id, playlistId: dir });
    assert.deepEqual(tracks.map((t) => t.id), [join(dir, 'real-file.mp3')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(realDir, { recursive: true, force: true });
  }
});

test('result order is deterministic and alphabetically sorted', async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, 'c.mp3'), '');
    await writeFile(join(dir, 'a.mp3'), '');
    await writeFile(join(dir, 'b.mp3'), '');
    const provider = createLocalFolderPlaylistProvider();
    const tracks = await provider.fetchPlaylist({ pluginId: provider.id, playlistId: dir });
    assert.deepEqual(tracks.map((t) => t.metadata.title), ['a', 'b', 'c']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fetchPlaylist rejects when playlistId does not exist', async () => {
  const provider = createLocalFolderPlaylistProvider();
  await assert.rejects(() =>
    provider.fetchPlaylist({ pluginId: provider.id, playlistId: '/no/such/directory-really-should-not-exist' })
  );
});

test('fetchPlaylist rejects when playlistId points at a file', async () => {
  const dir = await makeTempDir();
  try {
    const filePath = join(dir, 'not-a-dir.mp3');
    await writeFile(filePath, '');
    const provider = createLocalFolderPlaylistProvider();
    await assert.rejects(
      () => provider.fetchPlaylist({ pluginId: provider.id, playlistId: filePath }),
      /Not a directory/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty directory resolves to an empty array', async () => {
  const dir = await makeTempDir();
  try {
    const provider = createLocalFolderPlaylistProvider();
    const tracks = await provider.fetchPlaylist({ pluginId: provider.id, playlistId: dir });
    assert.deepEqual(tracks, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('initialize and dispose resolve without throwing', async () => {
  const provider = createLocalFolderPlaylistProvider();
  await provider.initialize({});
  await provider.dispose();
});

test('custom extensions and sourcePluginId config values are honored', async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, 'song.opus'), '');
    await writeFile(join(dir, 'song.mp3'), '');
    const provider = createLocalFolderPlaylistProvider({ extensions: ['opus'], sourcePluginId: 'custom-source' });
    const tracks = await provider.fetchPlaylist({ pluginId: provider.id, playlistId: dir });
    assert.deepEqual(tracks.map((t) => t.id), [join(dir, 'song.opus')]);
    assert.equal(tracks[0].sources[0].pluginId, 'custom-source');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
