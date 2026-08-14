# @unitrack/source-local-fs — Design Spec

Date: 2026-08-15

## Purpose

The first concrete `SourceProvider` plugin for `@unitrack/core`: resolves a
`SourceRef` pointing at a file on the local filesystem into a playable
`ResolvedSource`. This is the first real (non-mock) plugin built against
the core's plugin contracts, and the first consumer of the `./types`
export subpath added to `@unitrack/core`'s `package.json` for exactly this
purpose.

## Scope

**In scope:** implementing the `SourceProvider` contract
(`packages/core/src/types.js`) for local files — `canResolve`/`resolve`
only.

**Explicitly out of scope:**
- Scanning a directory or building `LogicalTrack`/playlist data — that is
  Playlist Provider territory (or a host's own responsibility), a separate
  future package.
- Reading ID3/audio-file metadata (artist/album/title/duration) — also
  future work, not this package.
- Bitrate detection — would require an audio-format parser (a real
  dependency); deferred.
- A full end-to-end integration test through a real `CorePlayer` — this
  package's own contract tests are sufficient to prove it satisfies
  `SourceProvider`; wiring it into a live player is exercised later when
  a real host/demo app exists.

## Package

New npm workspace package: `packages/source-local-fs/`, published as
`@unitrack/source-local-fs`. ESM (`"type": "module"`), zero runtime
dependencies — `@unitrack/core` is a **devDependency only**, needed
exclusively for JSDoc type-checking against `@unitrack/core/types` (the
package's own contract is a plain duck-typed object; nothing at runtime
imports code from `@unitrack/core`).

```
packages/source-local-fs/
├── package.json
├── tsconfig.json
├── src/
│   └── index.js
└── test/
    └── index.test.js
```

## Interface

A zero-argument factory, matching the `id`/`kind` convention already used
throughout `@unitrack/core`'s own test suite:

```js
export function createLocalFileSourceProvider() {
  return {
    id: 'local-fs',
    kind: 'local',
    canResolve(ref) { /* ... */ },
    async resolve(ref) { /* ... */ },
  };
}
```

**`SourceRef.sourceId`** for this provider is the absolute filesystem
path. **`ResolvedSource.url`** is a `file://` URI built via Node's
`url.pathToFileURL` — directly loadable by a browser/Electron `<audio>`
element or Web Audio's `fetch`, matching this project's original design
decision that the MVP playback engine is Web Audio-based.

```js
import { access, constants } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { extname } from 'node:path';

export function createLocalFileSourceProvider() {
  return {
    id: 'local-fs',
    kind: 'local',
    /** @param {import('@unitrack/core/types').SourceRef} ref @returns {boolean} */
    canResolve(ref) {
      return ref.pluginId === 'local-fs';
    },
    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {Promise<import('@unitrack/core/types').ResolvedSource>}
     */
    async resolve(ref) {
      await access(ref.sourceId, constants.R_OK);
      const url = pathToFileURL(ref.sourceId).href;
      const ext = extname(ref.sourceId).slice(1).toLowerCase();
      const resolved = { url };
      if (ext) resolved.format = ext;
      return resolved;
    },
  };
}
```

**`canResolve`** is synchronous and touches only `ref.pluginId` — no
filesystem access. Actual existence/readability is confirmed inside
`resolve()`, which is async specifically to allow this: `resolve` means
"confirm the source is playable right now," not just string construction.

**`resolve`** calls `fs.access(sourceId, constants.R_OK)` and lets it
reject naturally on failure (Node's own error, e.g. `ENOENT: no such file
or directory, access '...'`, is already informative) — no wrapping.
`packages/core/src/Resolver.js` already catches `resolve()` rejections and
records `err.message` into `failedSources`, so this needs no extra error
handling on this package's side.

**`format`** is derived from the file extension (lowercased, no leading
dot) and included only when present — never set to `undefined` explicitly,
so tests can use plain `assert.deepEqual` without extra-key surprises.
**`bitrate`** is never populated (out of scope, see above).

## Testing

Real temporary files via `node:fs/promises` (`mkdtemp` + `os.tmpdir()`),
no mocking of `fs`:

1. `canResolve` returns `true` for a ref with `pluginId: 'local-fs'`,
   `false` otherwise.
2. `resolve()` on an existing, readable file returns
   `{ url: 'file://<path>', format: '<ext>' }` matching the real temp
   file's `pathToFileURL`.
3. `resolve()` on a file with no extension returns `{ url }` with no
   `format` key.
4. `resolve()` on a nonexistent path rejects (`assert.rejects`).

## Non-goals

Restated from Scope: directory scanning, metadata/ID3 reading, bitrate
detection, and a full `CorePlayer` integration test are all out of scope
for this package.
