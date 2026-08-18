# @unitrack/metadata-local-fs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@unitrack/metadata-local-fs` — a `MetadataProvider` plugin for `@unitrack/core` that reads real embedded tags (artist/album/title/duration/cover art) from a local audio file via `fetchForSource(ref)` — as specified in `docs/superpowers/specs/2026-08-16-metadata-local-fs-design.md`. Approved by the user: taking `music-metadata` as this repo's first real runtime dependency, and `search()` always rejecting with an explicit "not supported" error.

**Architecture:** A single new npm workspace package, `packages/metadata-local-fs/`, exporting one factory function, `createLocalFileMetadataProvider(config)`, returning a plain object satisfying `@unitrack/core`'s `MetadataProvider` contract. `music-metadata` (`^11.14.0`) is a real runtime `dependencies` entry — the first in this repo. `@unitrack/core` stays a devDependency only, for JSDoc types.

**Tech Stack:** Plain JavaScript (ESM) with JSDoc types checked via `tsc --checkJs --strict`. Tests via Node's built-in `node:test` + `node:assert/strict`, run against real small tagged audio fixtures checked into `test/fixtures/` (see "Fixture provenance" below) — this package's tests need real parseable audio bytes, not a hand-rolled stand-in, so this is the one place in the repo where binary test fixtures are checked in rather than synthesized at test time.

## Global Constraints

- `music-metadata@^11.14.0` is a runtime dependency, confirmed MIT-licensed, ESM (`"type": "module"`), `engines.node: ">=18"`. `@unitrack/core`, `typescript`, `@types/node` stay devDependencies only.
- `fetchForSource` is the only real capability. `search` always rejects with the fixed message from the spec — never attempts any real work.
- No tag writing, no caching, no `apps/electron-demo` wiring, no multi-picture selection logic beyond "use the first embedded picture." All per spec Non-goals.
- `npm run typecheck` and `npm test`, run from the repo root, must both pass cleanly (delegating into every workspace package, including this new one) at the end of the task.

---

## Task 1: Generate and verify test fixtures

**Files:**
- Create: `packages/metadata-local-fs/test/fixtures/sample.mp3`
- Create: `packages/metadata-local-fs/test/fixtures/sample.wav`
- Create: `packages/metadata-local-fs/test/fixtures/sample.ogg`
- Create: `packages/metadata-local-fs/test/fixtures/sample.flac`
- Create: `packages/metadata-local-fs/test/fixtures/sample.m4a`
- Create: `packages/metadata-local-fs/test/fixtures/sample.aac`

These 6 files (one per extension `apps/electron-demo`'s file-picker filter covers) already exist in the repo as of this plan being written — generated and their `music-metadata` output verified empirically before writing this plan, exact commands and results below for the record. **This step is a checkpoint, not a re-generation** — confirm the files are present and re-run the verification script to make sure nothing has drifted; only regenerate if a fixture is missing or the verification output no longer matches.

**Generation commands** (all via `ffmpeg`, 1-second 440Hz sine tone as the audio payload — small, silent-to-the-ear, deterministic):

```bash
# 8x8 red PNG, used as embedded cover art for the mp3/flac fixtures
ffmpeg -y -f lavfi -i color=c=red:s=8x8 -frames:v 1 cover.png -loglevel error

# mp3 — full tags + embedded cover art (ID3v2.3 APIC frame)
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=1" -i cover.png -map 0:a -map 1:v \
  -c:a libmp3lame -id3v2_version 3 -c:v mjpeg -disposition:v attached_pic \
  -metadata artist="Test Artist" -metadata album="Test Album" -metadata title="Test Title" \
  sample.mp3 -loglevel error

# flac — full tags + embedded cover art (Vorbis comment + METADATA_BLOCK_PICTURE)
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=1" -i cover.png -map 0:a -map 1:v \
  -c:a flac -c:v png -disposition:v attached_pic \
  -metadata artist="Test Artist" -metadata album="Test Album" -metadata title="Test Title" \
  sample.flac -loglevel error

# ogg (vorbis) — full tags, no cover art
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=1" -c:a libvorbis \
  -metadata artist="Test Artist" -metadata album="Test Album" -metadata title="Test Title" \
  sample.ogg -loglevel error

# m4a (AAC in an MP4 container) — full tags, no cover art
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=1" -c:a aac \
  -metadata artist="Test Artist" -metadata album="Test Album" -metadata title="Test Title" \
  sample.m4a -loglevel error

# wav — full tags (RIFF INFO chunk), no cover art
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=1" -c:a pcm_s16le \
  -metadata artist="Test Artist" -metadata album="Test Album" -metadata title="Test Title" \
  sample.wav -loglevel error

# aac — raw ADTS elementary stream, deliberately left UNTAGGED: ADTS has no
# metadata container, so this is the "real file with no tags at all" fixture,
# used for the title-fallback test (Task 3, test 3) instead of an artificially
# stripped mp3.
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=1" -c:a aac -f adts \
  sample.aac -loglevel error
```

**Verified output** (`music-metadata@11.14.0`, `parseFile(path, { duration: true })`, run against these exact fixtures):

| file | artist | album | title | duration (s) | picture |
| --- | --- | --- | --- | --- | --- |
| `sample.mp3` | "Test Artist" | "Test Album" | "Test Title" | 1.0448979591836736 | 1× `image/jpeg`, 226 bytes |
| `sample.flac` | "Test Artist" | "Test Album" | "Test Title" | 1 | 1× `image/png`, 96 bytes |
| `sample.ogg` | "Test Artist" | "Test Album" | "Test Title" | 1 | none |
| `sample.m4a` | "Test Artist" | "Test Album" | "Test Title" | 1.023219954648526 | none |
| `sample.wav` | "Test Artist" | "Test Album" | "Test Title" | 1 | none |
| `sample.aac` | `undefined` | `undefined` | `undefined` | 1.0216780045351475 | none |

This confirms: every tagged format's `common.artist`/`common.album`/`common.title` round-trip correctly (including `wav`, whose RIFF-INFO-chunk tagging is less commonly exercised than ID3/Vorbis/MP4 but works via `music-metadata` the same way); `common.picture[0].format` is already a full MIME string (`image/jpeg`, `image/png`) — confirms the spec's `` `data:${picture.format};base64,...}` `` template needs no extra mapping from a bare extension to a MIME type; `sample.aac`'s lack of any tag container makes it the natural fixture for the title-fallback test, no artificial stripping needed; reported `duration` is close to but not exactly the requested 1-second input for several formats (codec framing/padding) — this is why the duration test (Task 3, test 4) uses a tolerance, not an exact match.

- [ ] **Step 1: Confirm the fixtures exist and re-verify**

Run (from `packages/metadata-local-fs/test/fixtures`, after `npm install` at the repo root has installed `music-metadata` — see Task 2):

```bash
node -e "
import('music-metadata').then(async ({ parseFile }) => {
  for (const f of ['sample.mp3','sample.wav','sample.ogg','sample.flac','sample.m4a','sample.aac']) {
    const md = await parseFile(f, { duration: true });
    console.log(f, md.common.artist, md.common.album, md.common.title, md.format.duration, md.common.picture?.length ?? 0);
  }
});
"
```

Expected: output matches the table above (small floating-point duration differences aside). If a fixture is missing, re-run its generation command from above.

---

## Task 2: Scaffold and implement @unitrack/metadata-local-fs

**Files:**
- Create: `packages/metadata-local-fs/package.json`
- Create: `packages/metadata-local-fs/tsconfig.json`
- Create: `packages/metadata-local-fs/src/index.js`

**Interfaces:**
- Consumes: `@unitrack/core`'s JSDoc types (`SourceRef`, `MetadataQuery`, `TrackMetadata`, `MetadataProvider`) from `packages/core/src/types.js`. Consumes `music-metadata`'s `parseFile` (default export path `music-metadata`) and Node built-ins `node:path` (`basename`, `extname`).
- Produces: `export function createLocalFileMetadataProvider(config?): MetadataProvider` from `packages/metadata-local-fs/src/index.js` — this package's entire public surface.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@unitrack/metadata-local-fs",
  "version": "0.1.0",
  "description": "Local file tag-reading Metadata Provider plugin for @unitrack/core",
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "main": "src/index.js",
  "exports": "./src/index.js",
  "scripts": {
    "test": "node --test test/*.test.js",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "music-metadata": "^11.14.0"
  },
  "devDependencies": {
    "@types/node": "^22",
    "@unitrack/core": "^0.1.0",
    "typescript": "^5.5.4"
  }
}
```

Note the new top-level `"dependencies"` field — every other package in this repo only has `"devDependencies"`. `"test": "node --test test/*.test.js"` — unquoted single-star glob, matching every other package (see commit `0a70d4e`). Do not reintroduce the quoted `**` form.

**`engines.node: ">=22"`, higher than every other package's `">=18"`, and `@types/node` bumped to `^22` (not `^18`) — both by explicit request.** This package's tests use `import.meta.dirname` (see Task 3) rather than the `fileURLToPath(import.meta.url)` workaround, so the real runtime floor is wherever that property exists (Node 20.11+/21.2+) — `>=22` is a clean, memorable round number above that, not a precisely-tuned minimum. Confirmed empirically (a scratch `tsc -p` run against `@types/node@18` vs `@types/node@22`, both under `"module": "NodeNext"`): `@types/node@^18` does **not** type `import.meta.dirname` at all (`Property 'dirname' does not exist on type 'ImportMeta'`) even though the property exists at runtime on a new-enough Node — `@types/node@^22` types it correctly. Bumping `@types/node` is a real necessity here, not a stylistic choice; getting this wrong would have been a typecheck failure indistinguishable in spirit from the `node --test` glob CI bug this repo already hit once. This only affects `@unitrack/metadata-local-fs`'s own `engines`/`@types/node` — every other package keeps `">=18"`/`^18`. One side effect worth flagging: the CI workflow's matrix still runs `20.x` and `22.x` for the whole workspace (no `engine-strict` is set anywhere in this repo, confirmed — no `.npmrc`), so `npm ci`/`npm test` on the `20.x` leg will likely still install and pass for this package (a same-major-line `20.x` GitHub Actions runner today resolves well above 20.11) despite its declared floor now reading `>=22` — a soft inconsistency, not a functional break; call it out if it ever actually fails on that leg.

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

Same as the other `local-fs` packages — no `"DOM"` in `lib`. `music-metadata` ships its own TypeScript types, so no `@types/music-metadata` is needed.

- [ ] **Step 3: Install from the repo root**

Run (from the repo root, not from inside `packages/metadata-local-fs`): `npm install`
Expected: npm recognizes the new workspace package, links `node_modules/@unitrack/core` and `node_modules/@unitrack/metadata-local-fs` as workspace symlinks, and this time also actually installs `music-metadata` and its own dependency tree into `node_modules` (not just a symlink — this is the first package with a real npm dependency to fetch).

- [ ] **Step 4: Implement `createLocalFileMetadataProvider`**

`packages/metadata-local-fs/src/index.js`:

```js
import { parseFile } from 'music-metadata';
import { basename, extname } from 'node:path';

/**
 * @param {string} filePath
 * @returns {string}
 */
function titleFromFilename(filePath) {
  const name = basename(filePath);
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

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
      const parsed = await parseFile(ref.sourceId, { duration: true });
      const { common, format } = parsed;

      /** @type {import('@unitrack/core/types').TrackMetadata} */
      const metadata = {
        artist: common.artist ?? '',
        album: common.album ?? '',
        title: common.title ?? titleFromFilename(ref.sourceId),
      };
      if (format.duration !== undefined) {
        metadata.duration = format.duration;
      }
      const picture = common.picture?.[0];
      if (picture) {
        metadata.coverArtUrl = `data:${picture.format};base64,${picture.data.toString('base64')}`;
      }
      return metadata;
    },
  };
}
```

- [ ] **Step 5: Run the typecheck**

Run: `npm run typecheck -w @unitrack/metadata-local-fs`
Expected: no errors. If `music-metadata`'s own types don't resolve cleanly under `strict: true`, check the installed version's `package.json` for its `types`/`exports` field before adding any workaround — do not add `skipLibCheck`-style suppressions beyond what's already in this package's `tsconfig.json`.

---

## Task 3: Write and pass the test suite

**Files:**
- Create: `packages/metadata-local-fs/test/index.test.js`

**Interfaces:**
- Consumes: `createLocalFileMetadataProvider` from `../src/index.js`, the fixture files from Task 1, Node's `node:test`/`node:assert/strict`/`node:fs/promises` (`mkdtemp`, `writeFile`, `rm`)/`node:os` (`tmpdir`)/`node:path` (`join`).

- [ ] **Step 1: Write the tests**

`packages/metadata-local-fs/test/index.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalFileMetadataProvider } from '../src/index.js';

// import.meta.dirname (Node >=20.11/21.2) is safe here — this package's own
// engines floor is Node >=22.
const FIXTURES = join(import.meta.dirname, 'fixtures');

test('fetchForSource reads artist/album/title from a tagged mp3', async () => {
  const provider = createLocalFileMetadataProvider();
  const metadata = await provider.fetchForSource({
    pluginId: 'local-fs', sourceId: join(FIXTURES, 'sample.mp3'), kind: 'local',
  });
  assert.equal(metadata.artist, 'Test Artist');
  assert.equal(metadata.album, 'Test Album');
  assert.equal(metadata.title, 'Test Title');
});

for (const file of ['sample.wav', 'sample.ogg', 'sample.flac', 'sample.m4a']) {
  test(`fetchForSource reads artist/album/title from a tagged ${file}`, async () => {
    const provider = createLocalFileMetadataProvider();
    const metadata = await provider.fetchForSource({
      pluginId: 'local-fs', sourceId: join(FIXTURES, file), kind: 'local',
    });
    assert.equal(metadata.artist, 'Test Artist');
    assert.equal(metadata.album, 'Test Album');
    assert.equal(metadata.title, 'Test Title');
  });
}

test('fetchForSource returns a coverArtUrl data: URL for a fixture with embedded art', async () => {
  const provider = createLocalFileMetadataProvider();
  const metadata = await provider.fetchForSource({
    pluginId: 'local-fs', sourceId: join(FIXTURES, 'sample.mp3'), kind: 'local',
  });
  assert.ok(metadata.coverArtUrl?.startsWith('data:image/jpeg;base64,'));
  const base64 = metadata.coverArtUrl.slice('data:image/jpeg;base64,'.length);
  const decoded = Buffer.from(base64, 'base64');
  assert.ok(decoded.length > 0);
  // A JPEG file starts with the SOI marker 0xFFD8.
  assert.equal(decoded[0], 0xff);
  assert.equal(decoded[1], 0xd8);
});

test('fetchForSource on an untagged file falls back to a filename-derived title', async () => {
  const provider = createLocalFileMetadataProvider();
  const metadata = await provider.fetchForSource({
    pluginId: 'local-fs', sourceId: join(FIXTURES, 'sample.aac'), kind: 'local',
  });
  assert.equal(metadata.artist, '');
  assert.equal(metadata.album, '');
  assert.equal(metadata.title, 'sample');
});

test('fetchForSource returns a duration close to the fixture\'s real ~1 second length', async () => {
  const provider = createLocalFileMetadataProvider();
  const metadata = await provider.fetchForSource({
    pluginId: 'local-fs', sourceId: join(FIXTURES, 'sample.mp3'), kind: 'local',
  });
  assert.ok(metadata.duration !== undefined);
  assert.ok(Math.abs(metadata.duration - 1) < 0.2, `expected ~1s, got ${metadata.duration}`);
});

test('fetchForSource rejects when the file does not exist', async () => {
  const provider = createLocalFileMetadataProvider();
  await assert.rejects(() =>
    provider.fetchForSource({ pluginId: 'local-fs', sourceId: join(FIXTURES, 'does-not-exist.mp3'), kind: 'local' })
  );
});

test('fetchForSource rejects when the file is not a recognizable audio format', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'metadata-local-fs-'));
  try {
    const filePath = join(dir, 'notes.txt');
    await writeFile(filePath, 'this is plainly not an audio file');
    const provider = createLocalFileMetadataProvider();
    await assert.rejects(() =>
      provider.fetchForSource({ pluginId: 'local-fs', sourceId: filePath, kind: 'local' })
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
```

10 tests total (4 individual tagged-format tests for mp3/wav/ogg/flac/m4a via the loop + the mp3-specific one = 5 "reads tags" tests, plus cover art, title-fallback, duration, nonexistent-file, unrecognized-format, and `search()` = 10) — covers every item in the spec's Testing section; the per-format loop (Testing section items covering wav/ogg/flac/m4a) is written as a `for` loop over fixtures rather than 4 near-identical copy-pasted test bodies, matching this repo's general preference for terse, non-repetitive tests where the bodies are truly identical.

- [ ] **Step 2: Run the tests**

Run: `npm test -w @unitrack/metadata-local-fs`
Expected: PASS — all 10 tests pass.

- [ ] **Step 3: Run the whole workspace's tests and typecheck from the root**

Run: `npm test` and `npm run typecheck` from the repo root.
Expected: both delegate into every workspace package and pass — 124 prior tests (80 core + 19 engine-web-audio + 6 source-local-fs + 7 source-subsonic + 12 playlist-local-fs) plus 10 new ones in `@unitrack/metadata-local-fs` (134 total), zero typecheck errors across every package including `apps/electron-demo`.

- [ ] **Step 4: Commit**

```bash
git add packages/metadata-local-fs package-lock.json
git commit -m "feat: add @unitrack/metadata-local-fs, a local file tag-reading Metadata Provider"
```

The fixture binaries (`test/fixtures/sample.*`) should already be staged as part of `packages/metadata-local-fs` from Task 1 — confirm `git status` shows them before committing; they are not generated by any build step, so they must be committed as real files, not gitignored.
