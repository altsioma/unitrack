# @unitrack/playlist-local-fs — Design Spec

Date: 2026-08-16

## Purpose

The first `PlaylistProvider` plugin for `@unitrack/core`, and the start of
Направление B (making `apps/electron-demo` a real app instead of a
single-file player). Today the demo builds one `LogicalTrack` by hand from a
single file chosen through a native file dialog
(`apps/electron-demo/preload.mjs`'s `open-file` handler). This package turns
a folder on disk into a whole `LogicalTrack[]` queue — walk a directory,
find audio files, produce tracks already wired to
`@unitrack/source-local-fs` — so the demo (and `CorePlayer.queue`, and
`QueueManager`'s not-yet-built shuffle/repeat) has more than one track to
actually exercise.

Consistent with `CorePlayer` never itself invoking `PlaylistProvider` or
`MetadataProvider` methods (confirmed architectural pattern: host owns
policy) — this package is a plain, standalone plugin. `CorePlayer` only
holds it via `registerPlaylistProvider`/`PluginRegistry.getPlaylistProvider`
for a host to look up and call directly; nothing in `CorePlayer` or
`Resolver.js` changes.

## Scope

**In scope:** implementing the `PlaylistProvider` contract
(`packages/core/src/types.js`) for a local directory — `fetchPlaylist` only.
Recursive directory walking, audio-extension filtering, and building
`LogicalTrack`/`SourceRef` values ready to hand to `@unitrack/source-local-fs`
with zero extra glue.

**Explicitly out of scope:**
- **ID3/real metadata.** Every produced `LogicalTrack.metadata` is
  filename-derived — `{ artist: '', album: '', title }` — the same
  placeholder shape `apps/electron-demo/preload.mjs`'s existing `open-file`
  handler already builds by hand
  (`{ artist: '', album: '', title }` from `filePath.split(/[\\/]/).pop()`).
  Real tag reading is the next Направление B sub-part (metadata/ID3),
  deliberately sequenced after this package so it can populate
  `LogicalTrack.metadata` for tracks this package already discovers, instead
  of the two being built together.
- **`listPlaylists()`.** Optional in the `PlaylistProvider` type, and
  omitted here: a raw folder scanner has no set of "known playlists" to
  enumerate — the `playlistId` *is* the location, supplied by the host (a
  folder-picker dialog, same as `open-file`'s file-picker today), not
  discovered by this package. Exactly the same boundary
  `@unitrack/source-local-fs` draws around `SourceRef.sourceId`: it takes an
  already-known path and never discovers one itself.
- **Watching the folder for changes.** `fetchPlaylist` is a one-shot scan of
  the directory as it is when called. No `fs.watch`, no live updates to an
  already-returned queue. A host wanting a refresh calls `fetchPlaylist`
  again.
- **Playlist files** (`.m3u`, `.pls`, ...). This package scans a directory
  of audio files, not a playlist-file format. A `playlist-m3u` package (if
  ever needed) would be a separate plugin, the same way `source-subsonic`
  and `source-local-fs` are separate packages for separate mechanisms.
- **Following symlinks.** See "Directory walking" below.

## Interface

```js
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
  extensions = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'],
  recursive = true,
} = {}) {
  return {
    id,
    /**
     * @param {import('@unitrack/core/types').PlaylistRef} playlistRef
     * @returns {Promise<import('@unitrack/core/types').LogicalTrack[]>}
     */
    async fetchPlaylist(playlistRef) {
      // 1. stat playlistRef.playlistId — reject if it doesn't exist or
      //    isn't a directory.
      // 2. walk it (depth-first, `recursive` controls whether subdirectories
      //    are descended into), skipping dotfiles/dot-directories and
      //    symlinks, collecting files whose extension (case-insensitive)
      //    is in `extensions`.
      // 3. sort the collected absolute paths so the result is deterministic.
      // 4. map each path to a LogicalTrack.
    },
  };
}
```

**`playlistRef.playlistId` is the absolute folder path.** Obtaining it
(a folder-picker dialog, a config file, a hardcoded demo path) is entirely
the host's job — this package never discovers folders on its own, mirroring
`@unitrack/source-local-fs` never discovering files on its own.

**`playlistRef.pluginId` is not checked inside `fetchPlaylist`.** Unlike
`SourceProvider.canResolve`, the `PlaylistProvider` contract has no
`canFetch`-style predicate — `PluginRegistry.getPlaylistProvider(id)` already
selects the right provider by `id` before a host calls `fetchPlaylist`, so
there is nothing left to defend against inside the method itself. This
mirrors the contract as written in `types.js`, not an omission.

**`sourcePluginId` defaults to `'local-fs'`** — the fixed `id` that
`@unitrack/source-local-fs`'s `createLocalFileSourceProvider()` always
returns (it takes no config; there is exactly one possible value for it in
this repo today). A host registering both packages with their defaults gets
a working, resolvable queue with zero extra glue: every `SourceRef` this
package produces has `pluginId: 'local-fs'`, which is exactly the `id`
`Resolver.js` will find registered. `sourcePluginId` stays configurable
regardless, for a host that ever registers `@unitrack/source-local-fs` under
a different plugin category — no other package in this repo does that, but
`SourceProvider.id` is host-assigned in principle, so hardcoding it here
would be an unnecessary extra coupling.

**Produced `LogicalTrack` shape**, for a file `/music/Artist/Album/01 Song.mp3`:

```js
{
  id: '/music/Artist/Album/01 Song.mp3',
  metadata: { artist: '', album: '', title: '01 Song' },
  sources: [{ pluginId: 'local-fs', sourceId: '/music/Artist/Album/01 Song.mp3', kind: 'local' }],
}
```

`id` is the absolute path — matches `preload.mjs`'s own precedent
(`id: filePath`) and is trivially unique per file. `title` is the filename
with its extension stripped (`basename` minus `extname`) rather than the
raw filename `preload.mjs` currently uses — a small, deliberate improvement
over that precedent (a title like "01 Song" reads better than "01
Song.mp3"), not a metadata-extraction step: it's string formatting on a
filename this package already has in hand, not a tag read, so it stays
inside this package's "no ID3" scope boundary. `artist`/`album` stay `''`,
matching `preload.mjs` exactly, to be filled in by the future metadata/ID3
package. `kind: 'local'` matches `@unitrack/source-local-fs`'s own `kind`.

## Directory walking

**Recursive by default** (`recursive: true`), because the common on-disk
layout this package expects to face is a nested music library
(`Artist/Album/Track.ext`), not a flat pile of files — matching what a user
picking "a folder of music" for the demo will actually have. `recursive:
false` scans only the top level, for the flat-single-folder case.

**Depth-first, sorted at each level**, using
`fs.promises.readdir(dir, { withFileTypes: true })` rather than the
`recursive: true` option `fs.readdir` itself gained — that option's
Node-version floor is above this package's own `engines.node: '>=18'` floor
(added experimentally in 18.17/20.1, unclear stabilization point across the
18.x line), so a small hand-rolled recursive walk is used instead, the same
reasoning `source-subsonic` applied to picking real Node globals over a
dependency: don't take on a version-sensitivity risk this project has
already been burned by once (the `node --test` glob CI failure). Sorting
each directory's entries before recursing/collecting makes the final
`LogicalTrack[]` order deterministic — significant here because that order
becomes queue order.

**Dotfiles and dot-directories are skipped** (name starts with `.`) — keeps
`.DS_Store`, `.git`, editor swap directories, etc. out of the walk, standard
convention.

**Symlinks are not followed** (`dirent.isSymbolicLink()` entries are
skipped entirely, files and directories alike) — avoids an unbounded/cyclic
walk from a symlink loop, and keeps this first version simple; nothing in
scope needs it. Revisit only if a real use case shows up.

**Extension matching is case-insensitive** (`.MP3` matches `mp3`), since
filesystems (especially macOS's default case-insensitive-but-preserving
one) make case a poor signal to rely on.

## Error Handling

`fetchPlaylist` rejects with a plain `Error` when:
- `playlistRef.playlistId` doesn't exist (`fs.stat` rejects) — message
  passes the underlying `fs` error through as-is, same reasoning
  `@unitrack/source-local-fs` applied to `fs.access`'s rejection.
- `playlistRef.playlistId` exists but isn't a directory —
  `` `Not a directory: ${playlistId}` ``.

An existing, readable directory with zero matching files resolves to `[]`
— not an error. An empty playlist is a valid, if uninteresting, playlist.

## Package

```
packages/playlist-local-fs/
├── package.json      — devDependencies: @unitrack/core, typescript, @types/node
├── tsconfig.json       — same shape as @unitrack/source-local-fs's (no "DOM" lib;
│                          node:fs/promises, node:path come from @types/node)
├── src/
│   └── index.js         — createLocalFolderPlaylistProvider({ id, sourcePluginId,
│                            extensions, recursive })
└── test/
    └── index.test.js
```

Zero runtime dependencies. `@unitrack/core` stays a devDependency only, for
JSDoc types against `@unitrack/core/types` — same posture as
`@unitrack/source-local-fs` and `@unitrack/source-subsonic`.

## Testing

Real temporary directories via `node:fs/promises.mkdtemp` +
`node:os.tmpdir()` (no mocking library, matching this project's established
practice — the same approach `@unitrack/source-local-fs` would use for
`fs`, applied here to directory trees instead of single files):

1. A flat directory of audio files returns one `LogicalTrack` per file,
   correctly shaped (`id`, `metadata`, `sources`) as documented above.
2. Non-audio files in the same directory (e.g. `cover.jpg`, `notes.txt`)
   are excluded.
3. Recursive mode (default) includes files nested in subdirectories.
4. `recursive: false` only includes top-level files, ignoring
   subdirectories entirely.
5. Extension matching is case-insensitive (a `.MP3` file is included).
6. Dotfiles and dot-directories are skipped (a hidden file at the top level
   and a file inside a hidden subdirectory are both excluded).
7. A symlink (to a file, and to a directory) is not followed / not
   included in the result.
8. Result order is deterministic and alphabetically sorted (verified by
   scanning a fixture tree built with names deliberately created out of
   alphabetical order, e.g. `c.mp3`, `a.mp3`, `b.mp3`).
9. `fetchPlaylist` rejects when `playlistId` doesn't exist.
10. `fetchPlaylist` rejects when `playlistId` points at a file, not a
    directory.
11. An existing, empty directory (or one with only non-audio files)
    resolves to `[]`.
12. Custom `extensions` and `sourcePluginId` config values are honored
    (e.g. configuring `extensions: ['opus']` picks up a `.opus` file that
    the default list would otherwise exclude; a custom `sourcePluginId`
    shows up in every produced `SourceRef.pluginId`).

## Non-goals

Restated from Scope: ID3/real metadata, `listPlaylists()`, live folder
watching, and playlist-file formats (`.m3u` etc.) are all out of scope for
this package.
