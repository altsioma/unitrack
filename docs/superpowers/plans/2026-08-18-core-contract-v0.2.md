# @unitrack/core — Plugin Contract v0.2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status note:** this plan documents work that has already been implemented, tested, and committed (`b0e031a`, `dcf6a60` on branch `feat/core-contract-v0.2`, off `master`). It is written retrospectively, after the plan's own design-spec companion document (`docs/superpowers/specs/2026-08-18-core-contract-v0.2-design.md`) and the original in-session spec/plan pair were lost to a sandbox reset mid-implementation. Every checkbox below reflects a step that was actually carried out; where the final code differs from an earlier draft, that's called out inline rather than silently smoothed over.

**Goal:** Land the v0.2.0 breaking-change plugin contract across `@unitrack/core` and every first-party plugin package — opaque `sourceId`/`displayName`, async `canResolve`/`canPlay`, `initialize`/`dispose` lifecycle, `capabilities` negotiation, revalidate/retry for expiring source refs, and `queueAuthority`-driven lookahead-plan playback for engine-owned queue advancement — as specified in `docs/superpowers/specs/2026-08-18-core-contract-v0.2-design.md`.

**Architecture:** Nine tasks, landed in dependency order: contract types and the two consumers that read them directly (`PluginRegistry`, `Resolver`) first; `CorePlayer`'s lifecycle guard second; `CorePlayer`'s lookahead-plan/`queueAuthority` branch third (depends on lifecycle existing, since `#loadAndPlayCurrent` is now reached only after `initializePlugins()`); then each plugin package brought up to the new contract shape independently (`source-local-fs`, `engine-web-audio`, `source-subsonic`, `metadata-local-fs` + `playlist-local-fs`); then the one real host, `electron-demo`, wired to call `initializePlugins()`/`dispose()`; then a final version-bump pass across every touched package's `package.json`.

**Tech Stack:** Plain JavaScript (ESM) with JSDoc types checked via `tsc --checkJs`. Tests via Node's built-in `node:test` + `node:assert/strict`. No new dependencies. npm workspaces monorepo.

## Global Constraints

- This is a breaking change to every plugin category's contract (`canResolve`/`canPlay` sync → async is not backward compatible — see the design spec's Implementation Decision 5). Every first-party plugin in this repo is updated in the same change; there is no dual sync/async transition period.
- `@unitrack/util-fs` is out of scope — no plugin-category contract, untouched, stays at `0.1.0`.
- `npm run typecheck` must report zero errors, and `npm test` must pass with pristine output, across every workspace package at the end of every task.
- Every package whose contract shape changes gets a `package.json` version bump to `0.2.0`, and every `package.json` that `devDependencies`/`dependencies`-references `@unitrack/core` (or another bumped package) gets that reference bumped to `^0.2.0` in the same pass (Task 9), not scattered across the earlier tasks — this keeps each earlier task's diff scoped to behavior, not bookkeeping.

---

## Task 1: Core contract types, PluginRegistry, Resolver revalidate/retry

**Files:**
- Modify: `packages/core/src/types.js`
- Modify: `packages/core/src/PluginRegistry.js`
- Modify: `packages/core/src/Resolver.js`
- Modify: `packages/core/test/PluginRegistry.test.js`
- Modify: `packages/core/test/helpers/mockPlugins.js`

**Interfaces:**
- Consumes: nothing new — this is the root of the change.
- Produces: `PluginContext`, `RevalidationResult`, `SourceProviderCapabilities`, `PlaybackPlanEntry`, `PlaybackEngineCapabilities` typedefs; `SourceRef.displayName`; `SourceProvider`/`PlaybackEngine`/`MetadataProvider`/`PlaylistProvider` contract shapes gain `capabilities` (source/engine only), `initialize`, `dispose`, async `canResolve`/`canPlay`, `revalidate` (source only). `PluginRegistry.getPlaybackEngineFor` becomes async; new `getPlaybackEngines()`. `Resolver.resolveTrack`'s retry branch.

- [x] **Step 1: Add the new typedefs and widen the four plugin-category contracts in `types.js`**

`SourceRef` gains optional `displayName`. Four new typedefs added (`PluginContext`, `RevalidationResult`, `SourceProviderCapabilities`, `PlaybackPlanEntry`, `PlaybackEngineCapabilities` — five, not four; see design spec Solution section for full shapes). `SourceProvider` and `PlaybackEngine` gain `capabilities`, `initialize`, `dispose` (required), and their `canResolve`/`canPlay` return types change to `Promise<boolean>`; `SourceProvider` gains optional `revalidate`; `PlaybackEngine`'s `on()` event union gains `'trackChanged'` and it gains optional `setPlaybackPlan`. `MetadataProvider`/`PlaylistProvider` gain `initialize`/`dispose` only.

- [x] **Step 2: Update `mockPlugins.js` test helpers to the new contract shape**

`createMockSourceProvider`/`createMockPlaybackEngine` updated so every test using them gets a v0.2.0-shaped mock by default: `capabilities` (source default `{ offline: true, requiresRevalidation: false }`; engine default `{ gapless: false, backgroundPlayback: false, queueAuthority: 'core' }`), async no-op `initialize`/`dispose`, async-wrapped `canResolve`/`canPlay` that call through to a `canResolveImpl`/`canPlayImpl` config property when the test supplies one (preserving every existing test's ability to configure sync-style behavior without rewriting its setup), default `revalidate` returning `{ valid: false, reason: 'mock provider does not support revalidation' }`. Engine mocks only get `plan`/`setPlaybackPlan` fields when constructed with `capabilities.queueAuthority === 'engine'`.

This step had to land before Step 4 (below) touched any `CorePlayer` test, since every `play()`-calling test in the suite depends on these mocks being contract-compliant.

- [x] **Step 3: Make `PluginRegistry.getPlaybackEngineFor` async; add `getPlaybackEngines`**

Changed from a synchronous `.find(engine => engine.canPlay(resolved))` to an async `for...of` loop `await`ing each registered engine's `canPlay(resolved)` in registration order, returning the first `true`. Added `getPlaybackEngines()` returning a shallow copy of the registered-engines array, used by `CorePlayer.initializePlugins()`/`dispose()` in Task 2.

Test: `packages/core/test/PluginRegistry.test.js`'s existing `getPlaybackEngineFor` tests converted to `async`/`await`; new test `'getPlaybackEngines returns every registered engine in registration order'`.

- [x] **Step 4: Add the revalidate/retry branch to `Resolver.resolveTrack`**

The per-provider resolution loop's `canResolve` check becomes `await`ed; a failed `resolve()` call now checks `provider.capabilities?.requiresRevalidation` before giving up — if set, it calls `provider.revalidate(ref)` (swallowing a throw as `{ valid: false }`), and on `{ valid: true, ref }` retries `resolve()` once against the revalidated ref. Any other outcome (revalidation itself fails, or the retried `resolve()` also fails) falls through to `failedSources.push(...)` exactly as the old code did for a provider without this capability. See design spec Implementation Decision 2 for why this is a single retry, not a loop.

- [x] **Step 5: Run tests and typecheck for `@unitrack/core`**

Run: `npm test -w @unitrack/core` and `npm run typecheck -w @unitrack/core`.
Result: pass, zero errors. (Full-suite `Resolver`/`CorePlayer` coverage of the retry path itself is exercised together with Task 4's `source-subsonic` work and Task 3's `CorePlayer` tests, since a meaningful revalidate/retry test needs a provider that actually declares `requiresRevalidation`.)

- [x] **Step 6: Commit**

Landed as part of the combined `feat(core): v0.2.0 breaking-change plugin contract...` commit (`b0e031a`) — see Task 9 for why this plan's tasks were committed together rather than one-per-task (unlike the 2026-08-15 hardening plan's per-task commits).

---

## Task 2: `CorePlayer` plugin lifecycle (`initializePlugins`/`dispose`, `PluginsNotInitializedError`)

**Files:**
- Modify: `packages/core/src/CorePlayer.js`
- Modify: `packages/core/src/index.js`
- Modify: `packages/core/test/CorePlayer.test.js`
- Modify: `packages/core/test/index.test.js`

**Interfaces:**
- Consumes: `PluginRegistry.getPlaybackEngines()` (Task 1), each plugin's `initialize`/`dispose` (Task 1's `types.js`).
- Produces: `CorePlayer.initializePlugins(hostContext)`, `CorePlayer.dispose()`, exported `PluginsNotInitializedError`.

- [x] **Step 1: Add `PluginsNotInitializedError`, `#initialized`, and the `play()` guard**

`PluginsNotInitializedError extends Error` added at module scope in `CorePlayer.js`. `#initialized` private field, defaulted `false`. `play()`'s public entry point throws `PluginsNotInitializedError` synchronously — before scheduling anything on the `#enqueue` operation chain — when `#initialized` is `false`.

- [x] **Step 2: Add `initializePlugins(hostContext)` and `dispose()`**

`initializePlugins(hostContext)` iterates every registered source provider, every playback engine (via the new `getPlaybackEngines()`), the metadata provider, and the playlist provider, `await`ing each one's `initialize(hostContext)`, then sets `#initialized = true`. `dispose()` does the mirror operation calling `dispose()` on the same set, then sets `#initialized = false` (so a disposed `CorePlayer` correctly requires re-initialization before it can `play()` again, matching Testing Decision 2 in the design spec).

- [x] **Step 3: Export `PluginsNotInitializedError` from `index.js`**

`export { CorePlayer, PluginsNotInitializedError } from './CorePlayer.js';` — also re-exported `TrackResolutionError` from `Resolver.js` in the same edit (previously internal-only; see design spec Solution, "`packages/core/src/index.js`").

- [x] **Step 4: Update every existing `CorePlayer.test.js` test that calls `play()`**

Every pre-existing test with a `core.setPolicy([{ kind: 'local' }]);` call had `await core.initializePlugins({});` inserted immediately after it (applied via a scoped `sed` pass across the 40 occurrences, then manually verified against a full test run rather than trusted blindly). One test with no `setPolicy` call (`'play on an empty queue is a no-op'`) needed its init call patched in by hand. One non-async test (`'getState reflects the queue, policy, and default idle status'`) was converted to `async () => {}` since it now needs to `await initializePlugins` even though it never calls `play()`.

- [x] **Step 5: Add new lifecycle tests**

Appended to `CorePlayer.test.js`: `play()` throws `PluginsNotInitializedError` before `initializePlugins()` has run; `initializePlugins()` calls `initialize()` on every registered plugin, asserting the passed `PluginContext`'s `host`/`config`/`log` fields reach each plugin; `dispose()` calls `dispose()` on every plugin, and a subsequent `play()` call throws `PluginsNotInitializedError` again (re-init required). Appended to `index.test.js`: `'the public entry point exports PluginsNotInitializedError'`.

- [x] **Step 6: Run tests and typecheck**

Run: `npm test -w @unitrack/core` and `npm run typecheck -w @unitrack/core`.
Result: pass, zero errors.

- [x] **Step 7: Commit**

Combined into `b0e031a` (see Task 9).

---

## Task 3: `CorePlayer` `queueAuthority`/lookahead-plan playback

**Files:**
- Modify: `packages/core/src/CorePlayer.js`
- Modify: `packages/core/test/CorePlayer.test.js`

**Interfaces:**
- Consumes: `engine.capabilities.queueAuthority`, `engine.setPlaybackPlan` (Task 1's `types.js`), `Resolver` (existing), Task 2's `#initialized` guard (lookahead-plan resolution only ever runs after `initializePlugins()`, since it's reached from `#loadAndPlayCurrent()` which `play()` only enters once initialized).
- Produces: `#resolveLookaheadPlan`, `#refreshLookaheadPlan`, `#reconcileEngineOwnedTrackChange`, the `#loadAndPlayCurrent()` branch, `'trackChanged'` event handling in `#bindEngine`.

- [x] **Step 1: Add the `DEFAULT_LOOKAHEAD_WINDOW` constant and the `#loadAndPlayCurrent()` branch**

Module-level `const DEFAULT_LOOKAHEAD_WINDOW = 3;`. `#loadAndPlayCurrent()` branches on `engine.capabilities?.queueAuthority === 'engine' && engine.setPlaybackPlan`: when true, resolves a lookahead plan and calls `engine.setPlaybackPlan(plan)` instead of the existing `engine.load(resolved)` / `engine.play()` pair, which remains the else-branch for core-owned engines, unchanged.

- [x] **Step 2: Implement `#resolveLookaheadPlan`**

Builds a `PlaybackPlanEntry[]` starting at the current queue item plus up to `DEFAULT_LOOKAHEAD_WINDOW` following items read from `queue.getItems()` in linear order (see design spec's documented limitation re: shuffle order — this is the code comment location referenced there), resolving each via the existing `Resolver`, and silently omitting any item whose resolution fails rather than aborting the whole plan.

- [x] **Step 3: Implement `#refreshLookaheadPlan` and wire it into the queue `'changed'` handler**

The constructor's existing `queue.on('changed', ...)` handler (which already had a branch reconciling core-owned playback against queue mutations) gained an `else if (loadedId)` branch that calls `this.#enqueue(() => this.#refreshLookaheadPlan())` — so adding/removing/reordering queue items while an engine-owned engine is actively playing re-resolves and re-pushes the plan.

- [x] **Step 4: Implement `'trackChanged'` handling and `#reconcileEngineOwnedTrackChange`**

`#bindEngine` now branches: engine-owned engines get a `'trackChanged'` listener wired to `#reconcileEngineOwnedTrackChange(queueItemId)`; core-owned engines keep the existing `'ended'` listener. `#reconcileEngineOwnedTrackChange` calls `queue.setCurrentIndex(...)` to move `CorePlayer`'s own cursor to match the item the engine reports having advanced to, so `getState().currentQueueItem` stays correct for a transition `CorePlayer` didn't itself initiate.

- [x] **Step 5: Add lookahead-plan/`queueAuthority` tests**

Appended to `CorePlayer.test.js`: an engine-owned mock engine receives a `setPlaybackPlan` call (not `load`/`play`) with the expected plan shape on `play()`; the same engine's (incorrectly, hypothetically) emitted `'ended'` event is ignored (only `'trackChanged'` is wired for engine-owned engines); a `'trackChanged'` event reconciles the queue cursor correctly; a queue mutation (add/remove) while an engine-owned engine is active triggers a `setPlaybackPlan` refresh call.

- [x] **Step 6: Run tests and typecheck**

Run: `npm test -w @unitrack/core` and `npm run typecheck -w @unitrack/core`.
Result: pass, zero errors. Full `@unitrack/core` count after Tasks 1–3: 122 tests.

- [x] **Step 7: Commit**

Combined into `b0e031a` (see Task 9).

---

## Task 4: `source-local-fs` contract update

**Files:**
- Modify: `packages/source-local-fs/src/index.js`
- Modify: `packages/source-local-fs/test/index.test.js`

**Interfaces:**
- Consumes: `SourceProvider` v0.2.0 shape (Task 1).
- Produces: `capabilities: { offline: true, requiresRevalidation: false }`, `initialize`/`dispose` no-ops, async `canResolve`, `revalidate` (re-attempts resolution).

- [x] **Step 1: Extract `resolveRef(ref)` and wire up the new contract fields**

Existing resolution logic factored into a `resolveRef(ref)` helper shared by `resolve()` and the new `revalidate()`. `capabilities`, no-op `initialize`/`dispose`, async `canResolve` (wraps the existing synchronous existence/type check), `revalidate` (re-attempts `resolveRef`, returning `{ valid: true, ref }` or `{ valid: false, reason }`) added. The existing directory-rejection behavior (`if (!stats.isFile()) throw new Error('Not a regular file: ...')`) is preserved verbatim inside `resolveRef`.

- [x] **Step 2: Update and add tests**

`canResolve` tests converted to `async`/`await`. New tests for `capabilities`, `initialize`+`dispose`, and `revalidate`'s success/failure shapes.

- [x] **Step 3: Run tests and typecheck**

Run: `npm test -w @unitrack/source-local-fs` and `npm run typecheck -w @unitrack/source-local-fs`.
Result: pass, zero errors. 10 tests.

- [x] **Step 4: Commit**

Combined into `b0e031a` (see Task 9).

---

## Task 5: `engine-web-audio` contract update

**Files:**
- Modify: `packages/engine-web-audio/src/index.js`
- Modify: `packages/engine-web-audio/test/index.test.js`
- Modify: `packages/engine-web-audio/test/helpers/domStubs.js`

**Interfaces:**
- Consumes: `PlaybackEngine` v0.2.0 shape (Task 1).
- Produces: `capabilities: { gapless: false, backgroundPlayback: false, queueAuthority: 'core' }`, `initialize` no-op, `dispose()` closing the `AudioContext`, async `canPlay`.

- [x] **Step 1: Add `capabilities`, `initialize`, `dispose`, async `canPlay`**

`dispose()` implemented as `if (audioContext.state !== 'closed') await audioContext.close();` — guarded because closing an already-closed `AudioContext` throws in some browser implementations. `on()`'s event-handling switch widened to accept `'trackChanged'` as a documented no-op (this engine is always core-owned and will never emit it, but the type signature accepts subscribing to it so a host's engine-agnostic event-bridge code doesn't need to special-case `queueAuthority` before wiring listeners). The existing `gainNode`-based volume chain (`sourceNode.connect(gainNode); gainNode.connect(audioContext.destination);`, `setVolume`/`getVolume` via `gainNode.gain.value`) is untouched.

- [x] **Step 2: Add `async close()` to the fake `AudioContext` test stub**

`domStubs.js`'s `createFakeAudioContext()` gained `async close() { this.state = 'closed'; }`, needed so `dispose()`'s guard condition is actually assertable in tests.

- [x] **Step 3: Update and add tests**

`canPlay` tests converted to `async`/`await`. New tests for `capabilities`, `initialize`, `dispose` (including the already-closed no-op case).

- [x] **Step 4: Run tests and typecheck**

Run: `npm test -w @unitrack/engine-web-audio` and `npm run typecheck -w @unitrack/engine-web-audio`.
Result: pass, zero errors. 28 tests.

- [x] **Step 5: Commit**

Combined into `b0e031a` (see Task 9).

---

## Task 6: `source-subsonic` contract update (revalidate/retry's real consumer)

**Files:**
- Modify: `packages/source-subsonic/src/index.js`
- Modify: `packages/source-subsonic/test/index.test.js`

**Interfaces:**
- Consumes: `SourceProvider` v0.2.0 shape (Task 1), exercised end-to-end against `Resolver`'s revalidate/retry branch (Task 1, Step 4).
- Produces: `capabilities: { offline: false, requiresRevalidation: true }`, `initialize`/`dispose` no-ops, async `canResolve`, `revalidate` (re-signs a fresh URL).

- [x] **Step 1: Extract `resolveRef(ref)` and wire up the new contract fields**

Same pattern as Task 4: existing signed-URL resolution logic factored into `resolveRef(ref)`, shared by `resolve()` and `revalidate()`. `capabilities`, no-op `initialize`/`dispose`, async `canResolve` added.

- [x] **Step 2: Implement `revalidate()`**

Re-signs a fresh URL by re-running `resolveRef(ref)`, returning `{ valid: true, ref }` on success. Note: an earlier draft returned `{ valid: true, ref, resolved }`, carrying the freshly-resolved payload alongside the ref as an optimization to avoid `Resolver` re-resolving. This was caught by `tsc --checkJs`'s excess-property check on object literals against the `RevalidationResult` typedef (which only declares `valid`/`ref`/`reason`) and corrected to `{ valid: true, ref }` — matching `Resolver`'s actual contract, which re-calls `provider.resolve(revalidation.ref)` itself rather than trusting a pre-resolved payload (see design spec, "`packages/source-subsonic`").

- [x] **Step 3: Update and add tests**

`canResolve` tests converted to `async`/`await`. New tests for `capabilities`, `initialize`+`dispose`, and `revalidate()`'s success and failure paths.

- [x] **Step 4: Run tests and typecheck**

Run: `npm test -w @unitrack/source-subsonic` and `npm run typecheck -w @unitrack/source-subsonic`.
Result: pass, zero errors. 11 tests.

- [x] **Step 5: Commit**

Combined into `b0e031a` (see Task 9).

---

## Task 7: `metadata-local-fs` and `playlist-local-fs` lifecycle-only update

**Files:**
- Modify: `packages/metadata-local-fs/src/index.js`
- Modify: `packages/metadata-local-fs/test/index.test.js`
- Modify: `packages/playlist-local-fs/src/index.js`
- Modify: `packages/playlist-local-fs/test/index.test.js`

**Interfaces:**
- Consumes: `MetadataProvider`/`PlaylistProvider` v0.2.0 shapes (Task 1) — `initialize`/`dispose` only, no `capabilities` (neither category participates in resolution/playback fallibility; see design spec, "Solution").
- Produces: no-op `initialize`/`dispose` on both packages.

- [x] **Step 1: Add `initialize`/`dispose` no-ops to both packages**

No other behavior change in either package — `metadata-local-fs`'s tag-reading logic and `playlist-local-fs`'s directory-scanning logic (extension filtering, recursive/non-recursive mode, dotfile/symlink exclusion, deterministic sort order, custom `extensions`/`sourcePluginId` config) are all untouched.

- [x] **Step 2: Add one test per package**

`'initialize and dispose resolve without throwing'`, appended to each package's `test/index.test.js`.

- [x] **Step 3: Run tests and typecheck**

Run: `npm test -w @unitrack/metadata-local-fs -w @unitrack/playlist-local-fs` and the matching `typecheck` scripts.
Result: pass, zero errors. 12 tests (`metadata-local-fs`), 13 tests (`playlist-local-fs`).

- [x] **Step 4: Commit**

Combined into `b0e031a` (see Task 9).

---

## Task 8: `electron-demo` host wiring

**Files:**
- Modify: `apps/electron-demo/main.js`
- Modify: `apps/electron-demo/preload.mjs`

**Interfaces:**
- Consumes: `metadataProvider.initialize()` directly (Task 7 — not registered with `CorePlayer`'s registry, so it can't go through `CorePlayer.initializePlugins()`); `core.initializePlugins()`/`core.dispose()` (Task 2).
- Produces: no new public interfaces — this is the one real host in the repo picking up the new lifecycle calls.

- [x] **Step 1: Call `metadataProvider.initialize()` directly in `main.js`**

Immediately after `const metadataProvider = createLocalFileMetadataProvider();`, added `metadataProvider.initialize({ log, config: {}, host: { platform: 'electron', version: process.versions.electron } }).catch((err) => log('main', 'metadataProvider.initialize() failed', err));`. This provider is used directly via the `fetch-metadata` IPC handler (`handleWithLogging('fetch-metadata', ...)`), never registered with `CorePlayer`, so it's initialized here rather than via `initializePlugins()`.

- [x] **Step 2: Call `core.initializePlugins()` in `preload.mjs`**

The `DOMContentLoaded` handler became `async`. After registering `source-local-fs` and `engine-web-audio` with `core` and before setting up the playlist provider, added `await core.initializePlugins({ log: (scope, message, detail) => log(\`core:${scope}\`, message, detail), config: {}, host: { platform: 'electron', version: process.versions.electron } });`.

- [x] **Step 3: Call `core.dispose()` on `beforeunload`**

Added a `beforeunload` listener near the end of the `DOMContentLoaded` handler, before the final `updateStatus()` calls, calling `core.dispose().catch(...)`.

- [x] **Step 4: Manual verification**

`apps/electron-demo` has no automated test suite (demo app; see `docs/superpowers/specs/2026-08-17-volume-design.md`'s Logging section for why this app logs verbosely instead — it's the only place these packages run in a real host). Verification for this task was `npm run typecheck -w @unitrack/electron-demo` only; no `electron .` manual smoke run was performed in-session (device bridge has no way to drive an interactive Electron window). Flagging this as the one task in this plan without a runtime verification step — worth a manual `electron .` check before this branch ships to anyone.

- [x] **Step 5: Run typecheck**

Run: `npm run typecheck -w @unitrack/electron-demo`.
Result: zero errors.

- [x] **Step 6: Commit**

Combined into `b0e031a` (see Task 9).

---

## Task 9: Version bumps and final commit

**Files:**
- Modify: `packages/core/package.json`
- Modify: `packages/source-local-fs/package.json`
- Modify: `packages/engine-web-audio/package.json`
- Modify: `packages/source-subsonic/package.json`
- Modify: `packages/metadata-local-fs/package.json`
- Modify: `packages/playlist-local-fs/package.json`
- Modify: `apps/electron-demo/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: nothing — bookkeeping pass over the previous eight tasks' output.
- Produces: nothing — no code-shape changes.

- [x] **Step 1: Bump every touched package to `0.2.0`**

`@unitrack/core`, `@unitrack/source-local-fs`, `@unitrack/engine-web-audio`, `@unitrack/source-subsonic`, `@unitrack/metadata-local-fs`, `@unitrack/playlist-local-fs`, `@unitrack/electron-demo` all bumped `"version": "0.1.0"` → `"0.2.0"`. `@unitrack/util-fs` deliberately left at `0.1.0` (see Global Constraints and design spec Out of Scope).

- [x] **Step 2: Bump internal `@unitrack/*` dependency ranges**

Every `package.json` with a `devDependencies`/`dependencies` entry on a bumped package updated its range to `^0.2.0` — e.g. `source-local-fs`'s `@unitrack/core` devDependency, `electron-demo`'s five `@unitrack/*` dependencies. `metadata-local-fs`'s dependency on `@unitrack/util-fs` is left at `^0.1.0` (unchanged, since `util-fs` itself wasn't bumped).

- [x] **Step 3: Run the full workspace test suite and typecheck from the repo root**

Run: `npm test` and `npm run typecheck` from the repo root.
Result: 201/201 tests passing (122 `@unitrack/core`, 28 `engine-web-audio`, 12 `metadata-local-fs`, 13 `playlist-local-fs`, 10 `source-local-fs`, 11 `source-subsonic`, 5 `util-fs`), zero typecheck errors across all 8 workspace packages.

- [x] **Step 4: Commit the full v0.2.0 migration**

```bash
git add <29 files across packages/, apps/electron-demo/, and the two version-bump-only changes>
git commit -m "feat(core): v0.2.0 breaking-change plugin contract — opaque sourceId, async canResolve/canPlay, plugin lifecycle, capabilities negotiation, queueAuthority lookahead-plan playback"
```

Landed as `b0e031a` on branch `feat/core-contract-v0.2` (based off `master`), 29 files changed. Note: this plan's Tasks 1–8 are each written above as if independently committed (matching the 2026-08-15 hardening plan's per-task-commit convention), but in practice all nine tasks' changes landed in this one commit — the work was done in a single continuous pass rather than task-by-task with intermediate commits, since the whole v0.2.0 contract is one indivisible unit from a consumer's point of view (a plugin can't be "half migrated" and still satisfy `PluginRegistry`/`CorePlayer`'s expectations). Each task above is still a useful unit for review/understanding, just not a literal separate commit boundary in this instance.

- [x] **Step 5: Commit the `package-lock.json` update**

A separate, mechanical `npm install`-driven `package-lock.json` update (reflecting the version bumps from Steps 1–2) landed as a second commit, `dcf6a60`, on the same branch.

---

## Follow-ups not covered by this plan

- Push `feat/core-contract-v0.2` to `origin` and open a PR — offered, not yet requested as of this plan's writing.
- A non-mutating "peek next N items" method on `QueueManager`, to make the lookahead-plan shuffle-aware (see design spec, Out of Scope).
- An actual `queueAuthority: 'engine'` playback engine implementation exercising the lookahead-plan plumbing against a real native queue (e.g. iOS background playback) — this plan ships the `CorePlayer`-side mechanism only.
- A manual `electron .` smoke run of Task 8's host wiring (see Task 8, Step 4) — the only task in this plan verified by typecheck alone rather than an executed run.
