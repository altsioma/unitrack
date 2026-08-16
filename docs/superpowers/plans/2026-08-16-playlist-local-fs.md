# @unitrack/playlist-local-fs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@unitrack/playlist-local-fs` — a `PlaylistProvider` plugin for `@unitrack/core` that scans a local directory and returns a `LogicalTrack[]` ready to resolve through `@unitrack/source-local-fs` — as specified in `docs/superpowers/specs/2026-08-16-playlist-local-fs-design.md`.

**Architecture:** A single new npm workspace package, `packages/playlist-local-fs/`, exporting one factory function, `createLocalFolderPlaylistProvider(config)`, returning a plain object satisfying `@unitrack/core`'s `PlaylistProvider` contract. No runtime dependency on `@unitrack/core` (devDependency only, for JSDoc types). Directory walking uses `node:fs/promises` (`readdir` with `withFileTypes: true`, `stat`) and `node:path` — all Node built-ins, no new runtime dependency.

**Tech Stack:** Plain JavaScript (ESM) with JSDoc types checked via `tsc --checkJs --strict`. Tests via Node's built-in `node:test` + `node:assert/strict`, against real temporary directories (`node:fs/promises.mkdtemp` + `node:os.tmpdir()`; no mocking library). Zero runtime dependencies.

## Global Constraints

- Zero runtime dependencies. `@unitrack/core`, `@types/node`, and `typescript` are devDependencies only.
- `fetchPlaylist` is the only method implemented. `listPlaylists` is intentionally omitted (optional in the contract; see spec Scope).
- Recursive by default (`recursive: true`), hand-rolled walk (not `fs.readdir`'s own `recursive` option — see spec, "Directory walking"), sorted at every level for deterministic output order.
- Dotfiles/dot-directories and symlinks (files and directories alike) are always skipped — not configurable in this first version.
- Extension matching against the configurable `extensions` list is case-insensitive.
- Out of scope for this plan (per spec Non-goals): ID3/real metadata, `listPlaylists()`, live folder watching, playlist-file formats (`.m3u` etc.), `apps/electron-demo` wiring.
- `npm run typecheck` and `npm test`, run from the repo root, must both pass cleanly (delegating into every workspace package, including this new one) at the end of the task.

---

## Task 1: Scaffold and implement @unitrack/playlist-local-fs

**Files:**
- Create: `packages/playlist-local-fs/package.json`
- Create: `packages/playlist-local-fs/tsconfig.json`
- Create: `packages/playlist-local-fs/src/index.js`
- Create: `packages/playlist-local-fs/test/index.test.js`

**Interfaces:**
- Consumes: `@unitrack/core`'s JSDoc types (`PlaylistRef`, `LogicalTrack`, `PlaylistProvider`) from `packages/core/src/types.js`, referenced via `import('@unitrack/core/types').X`, resolvable once `npm install` links the workspace. No runtime import from `@unitrack/core`. Consumes Node built-ins `node:fs/promises` (`readdir`, `stat`) and `node:path` (`join`, `extname`, `basename`).
- Produces: `export function createLocalFolderPlaylistProvider(config?): PlaylistProvider` from `packages/playlist-local-fs/src/index.js` — this package's entire public surface.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@unitrack/playlist-local-fs",
  "version": "0.1.0",
  "description": "Local folder-scanning Playlist Provider plugin for @unitrack/core",
  "type": "module",
  "engines": {
    "node": ">=18"
  },
  "main": "src/index.js",
  "exports": "./src/index.js",
  "scripts": {
    "test": "node --test test/*.test.js",
    "typecheck": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@types/node": "^18",
    "@unitrack/core": "^0.1.0",
    "typescript": "^5.5.4"
  }
}
```

`"test": "node --test test/*.test.js"` — unquoted single-star glob, matching the shell-expanded pattern every other package in this repo now uses (see commit `0a70d4e`, "fix: use a shell-expanded glob for node --test in every package"). Do not reintroduce the quoted `**` form.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.js"]
}
```

Same as `@unitrack/source-local-fs`'s `tsconfig.json` — no `"DOM"` in `lib`; nothing in this package needs browser globals.

- [ ] **Step 3: Install from the repo root**

Run (from the repo root, not from inside `packages/playlist-local-fs`): `npm install`
Expected: npm recognizes the new workspace package, links `node_modules/@unitrack/core` and `node_modules/@unitrack/playlist-local-fs` as workspace symlinks, installs `typescript`/`@types/node` for the new package.

- [ ] **Step 4: Write the failing tests**

`packages/playlist-local-fs/test/index.test.js`:

```js
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
```

12 tests, matching the spec's Testing section one-for-one.

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test -w @unitrack/playlist-local-fs` (or `npm test` from inside `packages/playlist-local-fs`)
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 6: Implement `createLocalFolderPlaylistProvider`**

`packages/playlist-local-fs/src/index.js`:

```js
import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';

const DEFAULT_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'];

/**
 * Depth-first walk of `dir`, sorted at every level so the result is
 * deterministic. Dotfiles/dot-directories and symlinks (files and
 * directories alike) are always skipped.
 *
 * @param {string} dir
 * @param {{ extensions: Set<string>, recursive: boolean }} config
 * @returns {Promise<string[]>}
 */
async function walk(dir, config) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (config.recursive) {
        files.push(...(await walk(fullPath, config)));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).slice(1).toLowerCase();
    if (config.extensions.has(ext)) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * @param {string} filePath
 * @param {string} sourcePluginId
 * @returns {import('@unitrack/core/types').LogicalTrack}
 */
function toLogicalTrack(filePath, sourcePluginId) {
  const name = basename(filePath);
  const ext = extname(name);
  const title = ext ? name.slice(0, -ext.length) : name;
  return {
    id: filePath,
    metadata: { artist: '', album: '', title },
    sources: [{ pluginId: sourcePluginId, sourceId: filePath, kind: 'local' }],
  };
}

/**
 * @param {{
 *   id?: string,
 *   sourcePluginId?: string,
 *   extensions?: string[],
 *   recursive?: boolean,
 * }} [config]
 * @returns {import('@unitrack/core/types').PlaylistProvider}
 */
export function createLocalFolderPlaylistProvider({
  id = 'local-fs',
  sourcePluginId = 'local-fs',
  extensions = DEFAULT_EXTENSIONS,
  recursive = true,
} = {}) {
  const extensionSet = new Set(extensions.map((ext) => ext.toLowerCase()));
  return {
    id,
    /**
     * @param {import('@unitrack/core/types').PlaylistRef} playlistRef
     * @returns {Promise<import('@unitrack/core/types').LogicalTrack[]>}
     */
    async fetchPlaylist(playlistRef) {
      const { playlistId } = playlistRef;
      const stats = await stat(playlistId);
      if (!stats.isDirectory()) {
        throw new Error(`Not a directory: ${playlistId}`);
      }
      const files = await walk(playlistId, { extensions: extensionSet, recursive });
      return files.map((filePath) => toLogicalTrack(filePath, sourcePluginId));
    },
  };
}
```

Note on `walk`'s traversal order: entries are sorted alphabetically before iterating, and a subdirectory's own (recursively sorted) files are spliced in at exactly the point that subdirectory's name falls in that order — not "all files, then all subdirectories." This satisfies the spec's "depth-first, sorted at each level" without needing a separate final sort pass across the whole tree.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w @unitrack/playlist-local-fs`
Expected: PASS — all 12 tests pass.

- [ ] **Step 8: Run the typecheck**

Run: `npm run typecheck -w @unitrack/playlist-local-fs`
Expected: no errors. If `import('@unitrack/core/types').X` fails to resolve, re-run `npm install` from the repo root first (Step 3).

- [ ] **Step 9: Verify the whole workspace still passes from the root**

Run: `npm test` and `npm run typecheck` from the repo root.
Expected: both delegate into every workspace package and pass — 112 prior tests (80 core + 19 engine-web-audio + 6 source-local-fs + 7 source-subsonic) plus 12 new ones in `@unitrack/playlist-local-fs` (124 total), zero typecheck errors across every package.

- [ ] **Step 10: Commit**

```bash
git add packages/playlist-local-fs
git commit -m "feat: add @unitrack/playlist-local-fs, a folder-scanning Playlist Provider"
```
