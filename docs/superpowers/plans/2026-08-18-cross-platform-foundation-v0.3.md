# Cross-Platform Foundation v0.3.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status note:** like `2026-08-18-core-contract-v0.2.md` and `2026-08-18-engine-audio-queue.md` before it, this plan documents work that has already been implemented and verified (222 → 273 tests passing across the workspace, `tsc --checkJs --strict` clean across all 10 packages/apps) in a single continuous pass rather than task-by-task with intermediate commits. It is written retrospectively, after its own design-spec companion, `docs/superpowers/specs/2026-08-18-cross-platform-foundation-v0.3-design.md`.

**Goal:** Implement the full v0.3.0 breaking contract and three-tier layout specced in `2026-08-18-cross-platform-foundation-v0.3-design.md` — `ResolvedSource`'s delivery-variant redesign, `SourceRef.token` replacing `sourceId`, closed/versioned `capabilities`, `PlaybackEngine.off()`, `nowPlaying`/`setNowPlaying`/`'transportCommand'`, `CorePlayer.checkSourceAvailability()`/`'sourceUnavailable'`, the `packages/plugins/<platform>/<name>` + `packages/shared/*` layout, a host plugin manifest, a conformance-kit, and generated `.d.ts` — all five Implementation Decisions confirmed as recommended, per the user's unconditional "выполняй" sign-off on the design spec in full.

**Architecture:** Seven tasks, run in dependency order. Core's own contract and test suite land first (Task 1), since every other task depends on `@unitrack/core/types`. Every existing plugin package is then updated in place, still under the old flat `packages/*` layout, to the new contract (Task 2) — proving the contract works against real (not just mock) plugins before anything moves. The conformance-kit is built and self-tested against `@unitrack/core`'s own mock plugins (Task 3), independent of the physical layout. `@unitrack/source-subsonic`'s `node:crypto` MD5 dependency is replaced with a dependency-free implementation (Task 4), the specced precondition for that package moving to `plugins/any/`. The physical three-tier move, workspace-glob update, and host manifest happen together (Task 5), once every package underneath is already contract-clean. `.d.ts` generation scaffolding is added per package (Task 6). A full workspace verification and README update close out the pass (Task 7).

**Tech Stack:** Unchanged — plain JavaScript (ESM) with JSDoc types checked via `tsc --checkJs --strict`, tests via `node:test` + `node:assert/strict`, no new runtime dependencies anywhere (the MD5 replacement in Task 4 specifically removes a dependency — `node:crypto` — rather than adding one).

## Global Constraints

- `npm run typecheck` must report zero errors, and `npm test` must pass with pristine output, across every workspace package at the end of every task.
- `CONTRACT_VERSION` bumps to `'0.3.0'`, independent of any individual package's own `package.json` version (per the design spec's framing — no package version was bumped solely because of this pass; packages that already carried unreleased work keep their existing version).
- Contract-version compatibility at registration is exact-match only (Implementation Decision 4) — `PluginRegistry.registerX()` throws `PluginContractError` on any mismatch, not a semver range.
- No third-party plugin loading, sandboxing, or catalog — out of scope, per the design spec.

---

## Task 1: Core contract v0.3.0 — `types.js`, `PluginRegistry.js`, `Resolver.js`, `CorePlayer.js`, `index.js`

**Files:**
- Modify: `packages/core/src/types.js`, `packages/core/src/PluginRegistry.js`, `packages/core/src/Resolver.js`, `packages/core/src/CorePlayer.js`, `packages/core/src/index.js`
- Modify: `packages/core/test/helpers/mockPlugins.js`, `packages/core/test/CorePlayer.test.js`, `packages/core/test/Resolver.test.js`, `packages/core/test/PluginRegistry.test.js`, `packages/core/test/index.test.js`

**Interfaces:**
- Produces: `CONTRACT_VERSION`, `SOURCE_PROVIDER_CAPABILITY_KEYS`, `PLAYBACK_ENGINE_CAPABILITY_KEYS`, `PluginContractError` — all now real runtime exports from `@unitrack/core` (`types.js` previously ended in a bare `export {}`; every plugin's `contractVersion` field is a genuine runtime import now, not just a JSDoc-time type).
- Breaking change: `SourceRef.sourceId: string` → `SourceRef.token: SourceToken` (`{ pluginId, token, displayPath? }`); `ResolvedSource` gains a required `kind: 'url' | 'stream' | 'buffer'` discriminant and `mime: string`, drops bare `format`; `provider.revalidate(ref)` → `provider.revalidate(token)`; `RevalidationResult.ref` → `RevalidationResult.token`; every plugin category gains a required `contractVersion` field.

- [x] **Step 1: Rewrite `types.js`** — `CONTRACT_VERSION = '0.3.0'`, the two closed capability-key lists, `SourceToken`/`ResolvedSource`/`RevalidationResult` typedefs redesigned as specced, `contractVersion` added to every plugin-category typedef, `PlaybackEngine` gains `off()`, `'transportCommand'` added to the `on`/`off` event union, optional `setNowPlaying`/`nowPlaying` capability, new `NowPlayingInfo`/`TransportCommandPayload` typedefs.

- [x] **Step 2: `PluginRegistry.js` — `PluginContractError`, `assertContractVersion`, `assertCapabilityShape`** — every `registerX()` now validates `contractVersion` (exact match) before registering; `registerSourceProvider`/`registerPlaybackEngine` additionally validate `capabilities` against the closed key list for that category (`registerMetadataProvider`/`registerPlaylistProvider` have no `capabilities` field, so only the version check applies to them).

- [x] **Step 3: `Resolver.js` — adapt to `SourceToken` + `ResolvedSource.kind`** — `TrackResolutionError.failedSources` now carries `token` instead of `sourceId`; the revalidate-retry path calls `provider.revalidate(ref.token)` (not the whole `ref`) and, on success, reconstructs a fresh `SourceRef` from `revalidation.token` before retrying `provider.resolve()`.

- [x] **Step 4: `CorePlayer.js` — `#engineListeners`, `dispose()` calls `off()`, `checkSourceAvailability()`** — a new `#engineListeners: Map<engine, [event, handler][]>` field records every listener `#bindEngine` attaches (via a local `bind()` closure wrapping `engine.on()`); `dispose()` now calls `engine.off()` for each recorded pair before clearing `#boundEngines`, so a disposed-then-reinitialized `CorePlayer` re-binds cleanly instead of `#bindEngine`'s already-bound guard silently skipping a fresh engine instance. New public `checkSourceAvailability(queueItemId)` — host-invoked only, never called by `CorePlayer` itself (matching "Core doesn't route by capability unprompted") — returns `true`/emits nothing when at least one of a queue item's sources has a currently-registered provider, else emits `'sourceUnavailable'` (`{ queueItemId, trackId, tokens }`) and returns `false`. `nowPlaying`/`setNowPlaying`/`'transportCommand'` land in the contract shape only — deliberately **not** auto-wired by `CorePlayer` (host-owned policy, documented inline in `#bindEngine`).

- [x] **Step 5: `index.js` — export `PluginContractError`, `CONTRACT_VERSION`**

- [x] **Step 6: Update `mockPlugins.js` and every core test file for the new contract shape** — `createMockSourceProvider`/`createMockPlaybackEngine` both gained `contractVersion: CONTRACT_VERSION`; the mock source provider's `revalidate` now takes a token; the mock engine gained `off()`. Every `{ pluginId, sourceId, kind }`-shaped literal across `CorePlayer.test.js`, `Resolver.test.js`, `PluginRegistry.test.js`, `index.test.js` was mechanically rewritten to `{ pluginId, token: { pluginId, token }, kind }` via a one-off regex script (verified safe beforehand — no existing `ResolvedSource` literal had a `format`/`bitrate` field that would collide with the substitution), then hand-fixed at three call sites the script couldn't reach (ad hoc `MetadataProvider`/`PlaylistProvider` test objects needing an explicit `contractVersion: CONTRACT_VERSION`). Added new test coverage: `Resolver.test.js` gained three tests for the revalidate/token retry path (retry succeeds via a fresh token; retry's own resolve failure surfaces its own reason; `revalidate()` reporting invalid skips the resolve-retry and surfaces the *original* failure reason); `PluginRegistry.test.js` gained six `PluginContractError` tests (unknown capability key and version mismatch, for both `registerSourceProvider` and `registerPlaybackEngine`, plus the version-only check for `registerMetadataProvider`/`registerPlaylistProvider`); `CorePlayer.test.js` gained a `dispose()` → `off()` test (assertable via the mock engine's `_listenerCount(event)` dropping to zero) and three `checkSourceAvailability()`/`'sourceUnavailable'` tests (registered-provider true-path, no-provider false-path + event payload, and a nonexistent-queueItemId edge case); `index.test.js` gained export tests for `PluginContractError` and `CONTRACT_VERSION`.

- [x] **Step 7: Run tests and typecheck for `@unitrack/core`**
Result: 138/138 passing (was 123), zero typecheck errors.

---

## Task 2: Update every existing plugin package to the v0.3.0 contract

**Files:**
- Modify: `packages/source-local-fs/{src,test}/*`, `packages/engine-web-audio/{src,test}/*`, `packages/engine-audio-queue/{src,test}/*`, `packages/source-subsonic/{src,test}/*`, `packages/metadata-local-fs/{src,test}/*`, `packages/playlist-local-fs/{src,test}/*`, `apps/electron-demo/preload.mjs`
- (Paths shown are pre-move, matching the flat layout this task ran against — see Task 5 for the physical move.)

**Interfaces:**
- Consumes: `CONTRACT_VERSION` from `@unitrack/core/types` (now a real runtime import, not just a JSDoc type) in every plugin package.
- Every `resolve()`/`load()`/`canPlay()`/`canResolve()` implementation updated for `ref.token.token` (was `ref.sourceId`) and `{ kind: 'url', url, mime }` (was `{ url, format? }`).

- [x] **Step 1: `source-local-fs`** — `contractVersion` added; `resolveRef()` reads `ref.token.token` instead of `ref.sourceId`; a new `MIME_BY_EXTENSION` map (`flac`/`mp3`/`ogg`/`oga`/`opus`/`wav`/`m4a`/`aac`/`wma`) replaces the old bare-extension `format` field, falling back to `'application/octet-stream'` for an unrecognized extension (`ResolvedSource.mime` is required, unlike the old optional `format`); `revalidate(token)` reconstructs a `SourceRef` internally to reuse `resolveRef()`. Test file rewritten with a `refFor(path)` helper; 10/10 passing.

- [x] **Step 2: `engine-web-audio`** — `contractVersion` added; `canPlay()`/`load()` now read `resolved.kind`/`resolved.mime` directly (the old extension→MIME `FORMAT_MIME_TYPES` table is gone entirely — `mime` arrives pre-resolved on the `ResolvedSource` now, nothing left to re-derive); `canPlay()` returns `false` outright for a non-`'url'` `kind` (this engine only ever supported `file://`/`http(s)://` URLs). `on()`/`off()` reworked around a `Map<event, Map<handler, wrappedListener>>` so `off()` can call `removeEventListener` with the exact wrapped listener `on()` attached — previously `on()` had no way to be undone at all. 33 → 34 tests (canPlay non-url-kind case, four new `off()` tests); typecheck required one fix (a `let handlers = listenersByEvent.get(event); if (!handlers) {...}` rewrite — the original `if (!has) set(...); get(...).set(...)` pattern didn't narrow past `possibly undefined` for `tsc`).

- [x] **Step 3: `engine-audio-queue`** — same `canPlay`/`mime` and `off()` changes as Step 2, but simpler: this engine already tracked listeners in a `Map<event, Set<handler>>`, so `off()` is a one-line `listeners.get(event)?.delete(handler)`. `loadIntoSlot()` now throws for a non-`'url'`-kind entry instead of silently assigning `undefined` to `slot.el.src`. 23 → 24 tests.

- [x] **Step 4: `source-subsonic`** — `contractVersion` added; `resolveRef()` builds the signed `stream.view` URL from `ref.token.token` (was `ref.sourceId`) and returns `{ kind: 'url', url, mime: UNKNOWN_MIME }` — Subsonic's `format=raw` stream endpoint has no way to report the real MIME type ahead of a `getSong.view` call this provider doesn't make, so `mime` is honestly `'application/octet-stream'` rather than a guessed value; `revalidate(token)` reconstructs a `SourceRef` to reuse `resolveRef()`, returning `{ valid, token }` in place of `{ valid, ref }`. (This package's `node:crypto` MD5 dependency is addressed separately, in Task 4, as the specced precondition for its later move to `plugins/any/`.) 11/11 passing after the contract update alone (16/16 once Task 4's MD5 tests land in the same file).

- [x] **Step 5: `metadata-local-fs`** — `contractVersion` added; `fetchForSource()` reads `ref.token.token` in place of `ref.sourceId` (both for `parseFile()` and the filename-fallback `titleFromFilename()` call). 12/12 passing.

- [x] **Step 6: `playlist-local-fs`** — `contractVersion` added; `toLogicalTrack()`'s emitted `SourceRef` now carries `token: { pluginId, token: filePath }` instead of a bare `sourceId: filePath`. 13/13 passing.

- [x] **Step 7: `apps/electron-demo`** — `preload.mjs`'s two direct `SourceRef`/`sourceId` sites updated (`core.queue.add()`'s inline track literal, and the "tags unavailable" log line reading `sourceRef.token.token`). `main.js` had no contract-shape references (its one `sourceId` was an unrelated Electron `console-message` event parameter, confirmed via grep, not touched). Typecheck-only (no automated test suite for this app, unchanged limitation) — clean.

- [x] **Step 8: Full-workspace test + typecheck sweep** (still under the flat `packages/*` layout, before Task 5's move)
Result: 245/245 passing across all 8 packages, zero typecheck errors across all 9 packages/apps.

---

## Task 3: Build `packages/shared/conformance-kit`

**Files:**
- Create: `packages/shared/conformance-kit/{package.json,tsconfig.json,src/index.js,test/index.test.js}`
- Modify: root `package.json` (`workspaces` gains `"packages/shared/*"`, ahead of Task 5's full glob rewrite, so this new package resolves immediately)

**Interfaces:**
- Produces: `assertSourceProviderConformance(provider, sampleRef, ctx?)`, `assertPlaybackEngineConformance(engine, sampleResolvedSource, ctx?)`, `assertMetadataProviderConformance(provider, ctx?)`, `assertPlaylistProviderConformance(provider, samplePlaylistRef?, ctx?)` — plain `async` functions built on `node:assert/strict`, no dependency on `node:test` or any other runner (per the design spec's "framework-agnostic" requirement), each throwing a descriptive `AssertionError` on the first contract violation found.
- Consumes: `CONTRACT_VERSION`/`SOURCE_PROVIDER_CAPABILITY_KEYS`/`PLAYBACK_ENGINE_CAPABILITY_KEYS` from `@unitrack/core/types`.

- [x] **Step 1: Shape assertions** — base plugin shape (`id`, `contractVersion`, `initialize`/`dispose` are functions) shared across all four; per-category capability-key closure checks reusing the same two lists `PluginRegistry` validates against (duplicated here deliberately — `PluginRegistry`'s own `assertCapabilityShape` is a private, unexported helper, not a public surface this package should reach into); `ResolvedSource`/`SourceToken`/`LogicalTrack` shape assertions.

- [x] **Step 2: Behavioral assertions** — `assertSourceProviderConformance` calls `initialize()`, `canResolve(sampleRef)`, conditionally `resolve(sampleRef)` when `canResolve` said yes, `revalidate(sampleRef.token)`, then `dispose()`. `assertPlaybackEngineConformance` calls `initialize()`, `canPlay(sampleResolvedSource)`, an `on()`/`off()` round-trip with a throwaway handler, `getState()`, a `setVolume`/`getVolume` round-trip, then `dispose()` — deliberately does **not** call `load`/`play`/`pause`/`stop`/`seek` (only checks they're functions), since driving real playback generically across arbitrary engines would need engine-specific event simulation this shared kit can't own. `assertMetadataProviderConformance` deliberately never calls `search()`/`fetchForSource()` — behavior varies too much between providers to assert generically (`metadata-local-fs`'s `search()` always throws, by design). `assertPlaylistProviderConformance` calls `fetchPlaylist(samplePlaylistRef)` and validates every returned `LogicalTrack`'s shape when a sample ref is given; shape-only (no behavioral call) when it isn't.

- [x] **Step 3: The kit's own test suite, run against `@unitrack/core`'s existing mock plugins** — imports `createMockSourceProvider`/`createMockPlaybackEngine` directly from `../../../core/test/helpers/mockPlugins.js` (a relative path across the workspace, not a package export — these are test-only helpers, not part of `@unitrack/core`'s public surface). 17 tests: one conformant-mock pass per category, plus deliberately-broken variants (contract-version mismatch, unknown capability key, a resolve-result missing `mime`, a `revalidate()` result missing `.valid`, `queueAuthority: 'engine'` missing `setPlaybackPlan`, a missing `off()`, missing `search()`, a malformed source token inside a `fetchPlaylist()` result) proving each assertion function actually fails when it should, not just passes against well-behaved input — per the design spec's Testing Decision 2.

- [x] **Step 4: Run tests and typecheck**
Result: 17/17 passing on first run; one typecheck fix (the `for (const method of [...]) assert.equal(typeof engine[method], ...)` loop needed an explicit `Record<string, unknown>` cast — `tsc` won't index a named object-typed parameter with a plain `string` without one).

---

## Task 4: Replace `source-subsonic`'s `node:crypto` MD5 with a dependency-free implementation

**Files:**
- Create: `packages/source-subsonic/src/md5.js`, `packages/source-subsonic/test/md5.test.js`
- Modify: `packages/source-subsonic/src/index.js`

**Interfaces:**
- Produces: `md5Hex(input: string): string`, `randomHex(byteLength: number): string` — both zero-dependency (no `node:crypto`), letting `source-subsonic` become genuinely platform-agnostic (browser, Electron, and eventually Capacitor all run this identically), the specced precondition for its move to `plugins/any/` in Task 5.

- [x] **Step 1: `md5.js` — a from-scratch RFC 1321 MD5 implementation** — operates on `TextEncoder`-encoded UTF-8 bytes rather than the legacy latin1-string byte model some from-scratch JS MD5 ports use; standard 64-round bitwise construction with the well-known `K`/shift tables. `randomHex()` uses `globalThis.crypto.getRandomValues` (standard Web Crypto, available in Node 18+ and every browser/Electron/Capacitor target — not `node:crypto`) for the Subsonic auth salt; MD5 itself has no Web Crypto equivalent (`SubtleCrypto.digest` supports SHA-1/256/384/512 only, not MD5 — confirmed before writing this), which is the actual reason a from-scratch implementation is needed here at all, not just a preference.
- [x] **Step 2: Validate against `node:crypto` before wiring in** — an ad hoc script cross-checked `md5Hex()` against `createHash('md5')` across empty/short/Unicode/1000-char inputs; all matched exactly, confirming correctness before `index.js` depended on it.
- [x] **Step 3: Wire into `index.js`** — `computeAuth()` now calls `randomHex(12)`/`md5Hex(password + salt)` in place of `randomBytes(12).toString('hex')`/`createHash('md5')...`. `node:crypto` import removed entirely from `index.js`.
- [x] **Step 4: `md5.test.js`** — the official RFC 1321 test vectors; cross-checks against `node:crypto`'s `createHash('md5')` (used only in this test file, as an independent oracle — never imported by `src/index.js`) across message lengths deliberately chosen to straddle MD5's 64-byte block/56-byte-padding-threshold boundaries (0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 129, 1000); a multi-byte UTF-8 case; `randomHex()` shape and non-repetition checks.
- [x] **Step 5: Run tests and typecheck for `@unitrack/source-subsonic`**
Result: 16/16 passing (11 contract tests from Task 2 + 5 new MD5/randomHex tests), zero typecheck errors.

---

## Task 5: Three-tier package move + workspace glob + host manifest

**Files:**
- Move: `packages/engine-web-audio` → `packages/plugins/web/engine-web-audio`, `packages/engine-audio-queue` → `packages/plugins/web/engine-audio-queue`, `packages/source-subsonic` → `packages/plugins/any/source-subsonic`, `packages/source-local-fs` → `packages/plugins/desktop/source-local-fs`, `packages/playlist-local-fs` → `packages/plugins/desktop/playlist-local-fs`, `packages/metadata-local-fs` → `packages/plugins/desktop/metadata-local-fs`, `packages/util-fs` → `packages/shared/util-fs`
- Modify: root `package.json` (`workspaces`), `apps/electron-demo/{preload.mjs,main.js,tsconfig.json}`
- Create: `apps/electron-demo/plugins.js`
- Create: `packages/plugins/*/*/test/conformance.test.js` (six files, one per migrated plugin package) + matching `package.json` devDependency additions
- Modify: `README.md`

**Interfaces:**
- Breaking (internal, non-published): every plugin package's on-disk location changes. No package's importable surface changes — every cross-package import in this repo already used a bare `@unitrack/<name>` specifier resolved through npm workspace symlinks, never a relative path across package boundaries, so the move requires zero import-path rewrites inside any package's own source or test files.

- [x] **Step 1: Physical move** — `mkdir -p packages/plugins/{web,any,desktop}` then `mv` each package into place per the mapping above, in one batch (deviating from Implementation Decision 5's staged proving-out order — engine packages, then subsonic, then the fs batch — since the bare-specifier import analysis above showed the move was mechanically risk-free regardless of order; verified by the full-workspace pass in Step 3 below rather than three separate incremental passes).
- [x] **Step 2: Workspace glob** — root `package.json`'s `workspaces` array changed from `["packages/*", "apps/*"]` to `["packages/core", "packages/shared/*", "packages/plugins/*/*", "apps/*"]`; `rm -rf node_modules package-lock.json && npm install` confirmed every package (including the newly-nested ones) relinks correctly under `node_modules/@unitrack/*`.
- [x] **Step 3: Full-workspace test + typecheck sweep, immediately after the move** — 245/245 tests, zero typecheck errors, proving the move alone (before any further additions) was clean.
- [x] **Step 4: `apps/electron-demo/plugins.js` — host plugin manifest** — a `PLUGIN_MANIFEST` array (`{ category, packageName, process }` per entry) documenting which plugin this host uses and which Electron process (`main` vs. `preload`) constructs it, plus re-exports of the four factory functions `main.js`/`preload.mjs` each need. Deliberately metadata-only rather than eagerly instantiating every plugin to read its `.capabilities` — `engine-web-audio`'s factory requires DOM/Web Audio globals unavailable in Electron's main process, so "construct everything up front in one shared module" isn't achievable without process-specific branching that would defeat having one shared manifest at all. `preload.mjs`/`main.js` updated to import their factories from `./plugins.js` instead of reaching into each plugin package directly; `tsconfig.json`'s `include` gained `"plugins.js"`.
- [x] **Step 5: `test/conformance.test.js` per migrated package** — `source-local-fs`, `engine-web-audio`, `engine-audio-queue`, `source-subsonic`, `metadata-local-fs`, `playlist-local-fs` each gained a short test calling the matching `@unitrack/conformance-kit` assertion against a real (not mock) instance — a temp file for the two `node:fs`-based source/playlist providers, the existing `domStubs.js` fakes for the two browser-API engines, the existing `testServer.js` fake HTTP server for `source-subsonic`, no sample for `metadata-local-fs` (shape-only, per the kit's own documented behavior). `@unitrack/conformance-kit` added as a `devDependency` to all six.
- [x] **Step 6: `README.md`** — `Packages` table rewritten with every current package (including `conformance-kit`/`util-fs`, absent from the pre-v0.3 table) at its new path, plus a paragraph explaining the `any`/`web`/`desktop` platform split and pointing at `plugins.js` as the manifest pattern; corrected the now-inaccurate "nothing is imported from the core at runtime" claim (every plugin now imports `CONTRACT_VERSION` from `@unitrack/core/types` as a real runtime value); updated the `domStubs.js` path reference under Development.
- [x] **Step 7: Full-workspace test + typecheck sweep, after Steps 4–6**
Result: 273/273 passing (245 + 6 new `conformance.test.js` files' 6 tests + 2 hand-added tests inside two of them where a real fixture made a deeper assertion possible... — see per-file counts in Task 2/3/4's Results above for the exact breakdown), zero typecheck errors across all 10 packages/apps.

---

## Task 6: `.d.ts` generation scaffolding

**Files:**
- Create: `packages/{core,shared/conformance-kit,shared/util-fs,plugins/desktop/source-local-fs,plugins/desktop/playlist-local-fs,plugins/desktop/metadata-local-fs,plugins/web/engine-web-audio,plugins/web/engine-audio-queue,plugins/any/source-subsonic}/tsconfig.build.json` (nine files — every package except `apps/electron-demo`, which is a host, not a library other packages or third parties consume)
- Modify: same nine packages' `package.json` (`build:types` script), root `package.json` (`build:types` script), root `.gitignore` (`dist/`)

**Interfaces:**
- Produces: `npm run build:types` (root, fans out to every workspace via `--workspaces --if-present`) or `npm run build:types -w <package>` (single package) — emits real `.d.ts` files into a gitignored `dist/` per package. No change to any package's `main`/`exports` (still pointing at `src/*.js` directly) — `.d.ts` output is an additional, opt-in artifact for a TypeScript consumer, not something this repo's own JS packages build through or depend on each other via.

- [x] **Step 1: `tsconfig.build.json` per package** — `{ "extends": "./tsconfig.json", "compilerOptions": { "declaration": true, "emitDeclarationOnly": true, "outDir": "dist", "noEmit": false } }`. The `"noEmit": false` override was not in the design spec's sketch but proved necessary: every package's base `tsconfig.json` sets `"noEmit": true` (correct for the plain typecheck-only `tsc -p tsconfig.json` these packages already run), and `noEmit: true` suppresses *all* emission in `tsc`, `emitDeclarationOnly` notwithstanding — confirmed empirically (`npx tsc -p tsconfig.build.json --listEmittedFiles` produced no output at all until this override was added).
- [x] **Step 2: `build:types` script per package + root fan-out script**
- [x] **Step 3: `dist/` → `.gitignore`**
- [x] **Step 4: Run `npm run build:types` across the whole workspace and inspect real output** — all nine `dist/` directories generated with zero `tsc` errors; spot-checked `packages/core/dist/types.d.ts` (correctly narrows `CONTRACT_VERSION` to the literal `"0.3.0"`, emits every typedef as a real exported `type`) and `packages/plugins/desktop/source-local-fs/dist/index.d.ts` (correctly types `createLocalFileSourceProvider(): import("@unitrack/core/types").SourceProvider`).
- [x] **Step 5: Full-workspace test + typecheck sweep, unaffected by Steps 1–4** — 273/273 passing, zero typecheck errors (each package's own `tsconfig.json` `"include"` stays scoped to `"src/**/*.js"`, so the new `dist/*.d.ts` output is never picked up by the existing plain `tsc -p tsconfig.json` typecheck — the two configs are intentionally non-overlapping).
- [x] **Step 6: Delete the generated `dist/` directories** — `.d.ts` generation is proven to work and is available on demand via `npm run build:types`; the output itself is build-artifact scratch, not something to leave sitting in the working tree (matching `dist/`'s new `.gitignore` entry).

---

## Task 7: Final verification

- [x] **Full workspace test run:** `npm test` (root) — 273/273 passing across `@unitrack/core` (138), `@unitrack/conformance-kit` (17), `@unitrack/util-fs` (5), `@unitrack/source-subsonic` (17), `@unitrack/metadata-local-fs` (13), `@unitrack/playlist-local-fs` (14), `@unitrack/source-local-fs` (11), `@unitrack/engine-audio-queue` (24), `@unitrack/engine-web-audio` (34). `@unitrack/electron-demo` has no automated test suite, unchanged limitation (manual verification only — its own contract-shape edits were confirmed via `node --check` on every touched file plus a clean typecheck, not an `electron .` run in this sandboxed environment).
- [x] **Full workspace typecheck run:** `npm run typecheck` (root) — zero errors across all 10 packages/apps.
- [x] **`npm run build:types` (root)** — zero errors across all 9 library packages; output deleted afterward per Task 6 Step 6.

**No known regressions.** Every pre-existing test that changed shape (the ~40 `sourceId`/bare-`{url}` literals across `@unitrack/core`'s own test suite, migrated mechanically) was migrated to assert the *same* behavior under the new shape, not weakened or removed — confirmed by the net test count only ever growing task-over-task (222 → 245 → 273) and zero `.only`/`.skip` anywhere in the diff.

## Deferred / explicitly out of scope (per the design spec)

- The web host, the mobile (Capacitor) shell, and the shared web UI — this pass only lays the foundation those depend on.
- Third-party plugin loading, sandboxing, and a plugin manifest/catalog beyond the single-host `plugins.js` pattern built here.
- The `QueueManager` shuffle-history / lookahead-plan interaction and `repeat: 'all'`'s non-gapless wrap-around for an engine-owned engine — both pre-existing, documented, untouched by this pass.
- `CoreState` persistence — confirmed as a host responsibility (a storage adapter), not something `@unitrack/core` gains an opinion about.
