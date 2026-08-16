# @unitrack/metadata-local-fs — Design Spec

Date: 2026-08-16

## Purpose

The first `MetadataProvider` plugin for `@unitrack/core`. `@unitrack/playlist-local-fs`
already produces a real multi-track queue from a folder scan, but every
`LogicalTrack.metadata` it builds is filename-derived —
`{ artist: '', album: '', title: '<filename without extension>' }` — because
reading real tags was explicitly out of that package's scope. This package
closes that gap: given a `SourceRef` pointing at a local audio file, read
its embedded tags (ID3v2 for MP3, Vorbis comments for FLAC/Ogg, MP4 atoms
for M4A/AAC, ...) and return real `artist`/`album`/`title`/`duration`/cover
art.

Consistent with the confirmed architectural pattern — `CorePlayer` never
itself invokes `MetadataProvider` or `PlaylistProvider` methods, host owns
policy — this package is a standalone plugin. A host (`apps/electron-demo`,
or any future host) is expected to call `fetchForSource(ref)` once per
track after `@unitrack/playlist-local-fs` returns a queue, and merge the
result into that track's `metadata` before handing the queue to
`CorePlayer`. Wiring that merge step into `apps/electron-demo` is out of
scope for this package (see Scope) — the same "package first, demo wiring
later" sequencing already used for `@unitrack/source-subsonic` and
`@unitrack/playlist-local-fs`.

## A scope decision that needs your input before I write the plan

Every package built so far in this repo — `@unitrack/source-local-fs`,
`@unitrack/source-subsonic`, `@unitrack/engine-web-audio`,
`@unitrack/playlist-local-fs` — has **zero runtime dependencies**. Reading
real audio tags is a fundamentally different kind of problem: ID3v2 (MP3),
Vorbis comments (FLAC/Ogg), and MP4 atoms (M4A/AAC) are three unrelated
binary formats, each with its own multi-page spec and edge cases
(text-encoding quirks, sync-safe integers, multiple tag versions coexisting
in one file, ...). Hand-rolling parsers for all three, to the level of
correctness a real music library would expose (embedded cover art,
non-ASCII text encodings, malformed-but-common real-world files), is a
large, error-prone undertaking out of proportion with everything else
that's been scoped so far.

I looked at what's available and want your sign-off before committing to
it: [`music-metadata`](https://github.com/Borewit/music-metadata) (npm,
current version **11.14.0**, confirmed via the npm registry). MIT-licensed,
ESM-native (`"type": "module"`, matching this repo), `engines.node: ">=18"`
(matching every package's own floor), actively maintained, and it already
supports every format `apps/electron-demo`'s file-picker filters for (mp3,
wav, ogg, flac, m4a, aac) plus a long tail of others. It is **not**
zero-dependency itself — its own `package.json` (confirmed via the npm
registry) lists 10 runtime dependencies of its own (`strtok3`,
`file-type`, `token-types`, `@tokenizer/token`, `debug`, and others —
mostly small binary-parsing/tokenizing utilities from the same author).

Taking this on would be this repo's first runtime dependency, full stop —
everything else has been "write a small real stand-in, don't add a
library." I think it's the right trade here (correctness on real-world
files vs. reinventing three binary tag formats from scratch for a
side/demo project), but this is a real precedent break, not a minor
detail, and I'd rather have your explicit go-ahead than assume it. If you'd
rather I hand-roll a minimal parser instead (e.g. ID3v2-only, MP3 first,
other formats later) — happy to re-scope around that instead; it's a
materially different (much larger, staged) plan.

## Scope

**In scope (assuming the dependency above is approved):** implementing the
`MetadataProvider` contract (`packages/core/src/types.js`) for local audio
files — `fetchForSource` only. Mapping `music-metadata`'s parsed output to
this repo's `TrackMetadata` shape, including a filename-derived title
fallback when a file has no title tag (reusing
`@unitrack/playlist-local-fs`'s own fallback convention) and a `data:` URL
for embedded cover art (no temp files, no server).

**Explicitly out of scope:**
- **`search(query)`.** Required by the `MetadataProvider` type, but has no
  meaningful implementation for a *local-file tag reader* — `search` is
  inherently a text-query capability (find candidates by artist/title),
  which is what an *online* metadata service (MusicBrainz, Discogs,
  Last.fm) does, not what reading an already-known file's embedded tags
  does. This package implements `search` only to satisfy the type
  structurally; it always rejects with a clear
  `Error('search() is not supported by @unitrack/metadata-local-fs — this provider only reads tags from an already-known local file via fetchForSource(); use an online metadata provider for search-by-text.')`
  — an explicit, documented "no" rather than a silent `[]`, the same
  "no silent gaps" posture `@unitrack/source-subsonic`'s spec applied to
  `ResolvedSource.format`. A future `@unitrack/metadata-musicbrainz` (or
  similar) package would be where `search` actually does something —
  separate mechanism, separate package, same split already drawn between
  `source-local-fs` and `source-subsonic`.
- **Writing/editing tags back to a file.** Read-only.
- **Caching parsed results across calls.** Every `fetchForSource` call
  re-parses the file. A host calling this once per track right after a
  playlist scan (the expected usage) doesn't need caching; one that wants
  to avoid re-parsing on every replay can cache the `TrackMetadata` itself
  — this package's job is a correct single read, not a cache.
  (Same "host's job, not this package's" reasoning
  `@unitrack/source-subsonic`'s spec applied to connectivity caching.)
- **Merging fetched metadata into a `LogicalTrack` / wiring into
  `apps/electron-demo`.** Host-side orchestration, deferred — see Purpose.
- **Picking a "best" cover art image by tag type when a file embeds more
  than one picture.** The first embedded picture (`common.picture[0]`) is
  used, unconditionally. Most taggers only embed one image anyway; type-aware
  selection (front cover vs. back cover vs. artist photo, per the ID3
  `PictureType` enum) is a real feature but adds real complexity for a
  case that's rare in practice. Revisit only if it turns out to matter
  against real files.

## Interface

```js
/**
 * @param {{ id?: string }} [config]
 * @returns {import('@unitrack/core/types').MetadataProvider}
 */
export function createLocalFileMetadataProvider({ id = 'metadata-local-fs' } = {}) {
  return {
    id,
    /**
     * @param {import('@unitrack/core/types').MetadataQuery} query
     * @returns {Promise<import('@unitrack/core/types').TrackMetadata[]>}
     */
    async search(query) {
      throw new Error(
        'search() is not supported by @unitrack/metadata-local-fs — this ' +
        'provider only reads tags from an already-known local file via ' +
        'fetchForSource(); use an online metadata provider for search-by-text.'
      );
    },
    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {Promise<import('@unitrack/core/types').TrackMetadata>}
     */
    async fetchForSource(ref) {
      // 1. parseFile(ref.sourceId, { duration: true }) — ref.sourceId is
      //    the absolute local path, the same convention
      //    @unitrack/source-local-fs and @unitrack/playlist-local-fs use.
      // 2. map common.artist/album/title (falling back to '' / a
      //    filename-derived title, matching playlist-local-fs's own
      //    fallback) and format.duration onto TrackMetadata.
      // 3. if common.picture?.[0] exists, set coverArtUrl to a `data:`
      //    URL built from its format (MIME type) and base64-encoded data.
    },
  };
}
```

`fetchForSource` takes any `SourceRef` and treats `ref.sourceId` as a local
filesystem path — there is no `pluginId` check, the same reasoning
`@unitrack/playlist-local-fs`'s spec applied to `PlaylistRef.pluginId`:
`MetadataProvider`, like `PlaylistProvider`, has no `canFetch`-style
predicate in its contract, so there's nothing to defensively check — a
host is expected to only call this provider for source refs it knows are
local files. Passing a ref that isn't a real local path fails naturally
(the underlying `fs` read inside `music-metadata` rejects with its own
clear error), which is an adequate safety net without adding a redundant
check this package's contract doesn't actually call for.

`id` defaults to `'metadata-local-fs'`, following this repo's existing
convention of "the plugin category, not the format" for local-mechanism
plugin ids (compare `'local-fs'` for both `source-local-fs` and
`playlist-local-fs`'s defaults).

### Mapping `music-metadata`'s output to `TrackMetadata`

Confirmed against the current README (`Borewit/music-metadata`, master):

| `TrackMetadata` field | Source | Fallback when absent |
| --- | --- | --- |
| `artist` | `metadata.common.artist` | `''` |
| `album` | `metadata.common.album` | `''` |
| `title` | `metadata.common.title` | filename minus extension (same helper `@unitrack/playlist-local-fs` uses) |
| `duration` | `metadata.format.duration` (seconds) | left `undefined` (optional field) |
| `coverArtUrl` | `` `data:${metadata.common.picture[0].format};base64,${metadata.common.picture[0].data.toString('base64')}` `` | left `undefined` (optional field) |

**`{ duration: true }` is passed to `parseFile`.** `music-metadata`
defaults `duration` to `false` (skip full-file parsing for speed) —
explicitly turned on here because an accurate duration matters for a
player's seek bar/progress display, and `TrackMetadata.duration` existing
at all only has value if it's trustworthy. This does mean a full parse per
file (slower than a tags-only read, especially for large FLACs) — an
accepted, deliberate trade for correctness, not an oversight; revisit with
a `duration: false`-by-default + lazy fetch only if this proves slow
against a real library.

**Cover art as a `data:` URL, not a file path or a served endpoint.**
`music-metadata` returns embedded art as a raw `Buffer` + MIME type, not a
URL — but `TrackMetadata.coverArtUrl` is a `string`. Base64-encoding into a
`data:` URL needs no temp files and no local HTTP server, consistent with
this repo's "don't stand up infrastructure you don't need" posture; the
resulting string can go straight into an `<img src>` in
`apps/electron-demo` (once that wiring happens, out of scope here). The
downside — a `data:` URL duplicates the image bytes as base64 text
in-memory for as long as the `TrackMetadata` object is held — is accepted
as fine for a single-track-at-a-time demo; a host managing a very large
library with cover art for every track might want to revisit this
(write-to-temp-file-and-serve, or an on-demand fetch instead of eager) as
a follow-up, not now.

## Error Handling

`fetchForSource` rejects with whatever `music-metadata`'s `parseFile`
itself rejects with — no wrapping. Its own errors are already specific
(nonexistent file, unreadable file, unrecognized/malformed format), the
same "don't wrap an already-informative underlying error" reasoning
`@unitrack/source-local-fs` applied to `fs.access` and
`@unitrack/source-subsonic` applied to `fetch`'s own rejection.

`search` always rejects with the fixed, explicit "not supported" `Error`
documented above — never called with real network/fs activity, so there's
nothing to fail into at that point except the deliberate rejection itself.

## Package

```
packages/metadata-local-fs/
├── package.json      — dependencies: music-metadata (see below);
│                         devDependencies: @unitrack/core, typescript, @types/node
├── tsconfig.json       — same shape as the other local-fs packages (no "DOM" lib)
├── src/
│   └── index.js         — createLocalFileMetadataProvider({ id })
└── test/
    ├── fixtures/          — small real audio files with known embedded tags,
    │                         one per format apps/electron-demo's file filter
    │                         covers (mp3, wav, ogg, flac, m4a, aac) — see Testing
    └── index.test.js
```

**First package in this repo with a real (non-`@unitrack/core`) runtime
`dependencies` entry**: `"music-metadata": "^11.14.0"`. Everything else
(`@unitrack/core`, `typescript`, `@types/node`) stays a devDependency only,
same as every prior package.

## Testing

This is the one place this package's testing approach genuinely differs
from every prior package's "hand-rolled real stand-in, no fixtures shipped
as binary blobs" posture — reading real tags needs real tagged audio
files, not something a test can synthesize with `fs.writeFile('', ...)`
the way `@unitrack/playlist-local-fs`'s tests use empty placeholder files
(those only needed to exist and have the right extension, never to be
*parsed*). Small (silence, sub-second, a few KB each), redistributable,
explicitly-tagged fixture files — one per extension
`apps/electron-demo` filters for (mp3, wav, ogg, flac, m4a, aac) — checked
into `test/fixtures/`, each with a known artist/album/title baked in
(and one fixture additionally carrying embedded cover art, to test the
`coverArtUrl` path). Exact fixture provenance/generation (e.g. `ffmpeg`
generating short silent audio + `music-metadata`'s own sibling write-tool
or a tagging CLI to embed known tags) gets nailed down in the implementation
plan, since it's a real "how exactly do I produce these bytes" question,
not a design-level one.

1. `fetchForSource` on each fixture format returns the known
   artist/album/title baked into that fixture.
2. `fetchForSource` on the fixture with embedded cover art returns a
   `coverArtUrl` starting with `data:image/...;base64,` whose decoded
   bytes match the fixture's known embedded image.
3. `fetchForSource` on a fixture with no title tag falls back to a
   filename-derived title (an untagged fixture, or a fixture with just the
   title tag stripped).
4. `fetchForSource` returns a `duration` close to (within a small
   tolerance of) the fixture's known real duration.
5. `fetchForSource` rejects when `ref.sourceId` doesn't exist.
6. `fetchForSource` rejects when `ref.sourceId` points at a file that
   isn't a recognizable audio format (e.g. a `.txt` file).
7. `search()` always rejects with the documented "not supported" message,
   regardless of the query passed in.

## Non-goals

Restated from Scope: `search()`, tag writing, caching, `apps/electron-demo`
wiring, and type-aware multi-picture selection are all out of scope for
this package.
