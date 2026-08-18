# @unitrack/core — Plugin Contract v0.2.0 — Design Spec

Date: 2026-08-18

## Problem Statement

The v0.1.0 plugin contract (`SourceProvider`, `PlaybackEngine`, `MetadataProvider`, `PlaylistProvider`) has four gaps that only show up once real plugins start doing real, fallible, asynchronous work instead of the synchronous, always-succeeding mock implementations the test suite was built against:

1. **`sourceId` is treated as a stable, durable identifier**, but for a provider like `source-subsonic` it is really a signed, time-limited stream URL. There is no way for a provider to say "this identifier has expired, here is a fresh one" — `Resolver` either gets a working URL or a hard failure, with no retry path.
2. **`canResolve`/`canPlay` are synchronous**, which forces every provider/engine to answer capability questions from data it already has in memory. A provider that needs to check "is this file still on disk" or "is this codec actually decodable on this device" before answering has no way to do that check asynchronously.
3. **Plugins have no lifecycle.** They are constructed and immediately assumed ready. There is no hook for a plugin to open a connection, warm a cache, or negotiate host capabilities before `CorePlayer` starts calling its methods, and no hook to release resources (an open `AudioContext`, a Subsonic session) when the host shuts down.
4. **`CorePlayer` always drives playback item-by-item** (`engine.load(track)` then `engine.play()`, one queue item at a time), which is the only model some engines can't sustain. On iOS/iPadOS Safari and in Electron's `BrowserWindow` when it loses focus, WKWebView (and Chromium's background-tab throttling, to a lesser degree) suspends JS timers and can suspend the JS thread's ability to promptly react to a `'ended'` event. An engine that owns native queue advancement (e.g. wraps `AVQueuePlayer` or a native media session) needs to be handed a plan up front, not driven one `load()`/`play()` call at a time from JS that might not run when the track boundary actually happens.

None of these are hypothetical: (1) and (2) are required for `source-subsonic` to be a correct implementation rather than a demo-only stub, and (4) is required before any future engine plugin can target background playback on mobile without silently dropping track transitions while the app is backgrounded.

## User Stories

1. As the author of `source-subsonic`, I want to return "this URL is stale, please retry" instead of a hard failure, so that a track doesn't fail to play just because its signed URL happened to expire between playlist load and playback.
2. As the author of a future streaming source provider, I want `canResolve` to be async, so I can check network reachability or auth-token validity before `Resolver` commits to trying (and failing) a full `resolve()`.
3. As the author of a future codec-detection playback engine, I want `canPlay` to be async, so I can probe actual decodability (e.g. via a throwaway `HTMLMediaElement.canPlayType` + a short decode attempt) instead of guessing from a static extension/MIME list.
4. As a host application (`electron-demo` today, a future mobile shell tomorrow), I want a single `initializePlugins(hostContext)` call that lets every registered plugin set itself up (open connections, read config, negotiate capabilities) before I call `play()`, and a single `dispose()` call that tears all of them down when the app is closing.
5. As the author of a future native-queue-owning playback engine (e.g. one wrapping `AVQueuePlayer` for iOS background playback), I want to declare `queueAuthority: 'engine'` and receive a lookahead plan of upcoming tracks up front, so track-to-track advancement keeps working even while the JS thread is suspended by the OS or by WKWebView's background throttling.
6. As a maintainer reading `CorePlayer`, I want it to refuse to `play()` before `initializePlugins()` has run, with a specific, catchable error, rather than failing deep inside a plugin call with a confusing "cannot read property of undefined."

## Solution

### `packages/core/src/types.js`

`SourceRef` gains `displayName` (optional, human-readable label a UI can show for a source before/without resolving it — e.g. "Local file" vs. "Subsonic stream"). `sourceId` itself was already opaque in practice; this formalizes that no code outside the owning provider should parse or reconstruct it.

Four new typedefs:

```js
/**
 * @typedef {Object} PluginContext
 * @property {(scope: string, message: string, detail?: unknown) => void} [log]
 * @property {Record<string, unknown>} [config]
 * @property {{ platform: string, version?: string }} [host]
 */

/**
 * @typedef {Object} RevalidationResult
 * @property {boolean} valid
 * @property {import('./types.js').SourceRef} [ref]
 * @property {string} [reason]
 */

/**
 * @typedef {Object} SourceProviderCapabilities
 * @property {boolean} [offline]
 * @property {boolean} [requiresRevalidation]
 */

/**
 * @typedef {Object} PlaybackPlanEntry
 * @property {string} queueItemId
 * @property {{ url: string, [key: string]: unknown }} resolved
 */

/**
 * @typedef {Object} PlaybackEngineCapabilities
 * @property {boolean} [gapless]
 * @property {boolean} [backgroundPlayback]
 * @property {'core' | 'engine'} [queueAuthority]
 */
```

`SourceProvider` gains `capabilities` (optional `SourceProviderCapabilities`), `initialize(ctx: PluginContext): Promise<void>`, `canResolve` changed from `(ref) => boolean` to `(ref) => Promise<boolean>`, `revalidate(ref): Promise<RevalidationResult>` (optional — only meaningful when `capabilities.requiresRevalidation` is `true`), and `dispose(): Promise<void>` (now required, not optional — every plugin must at minimum have a no-op).

`PlaybackEngine` gains `capabilities` (optional `PlaybackEngineCapabilities`), `initialize`, `canPlay` changed to async, its `on()` event union widened from `'ended' | 'error' | 'progress'` to include `'trackChanged'`, `dispose` (now required), and `setPlaybackPlan(plan: PlaybackPlanEntry[]): Promise<void>` (optional — only present on engines that declare `capabilities.queueAuthority === 'engine'`).

`MetadataProvider` and `PlaylistProvider` gain `initialize`/`dispose` only — they have no capability-negotiation surface, since neither one is in the playback-critical path that `capabilities` exists to describe.

Everything already in `types.js` for volume, shuffle, and repeat (`RepeatMode`, `CoreState.shuffle`/`repeatMode`/`volume`) is untouched by this change.

### `packages/core/src/Resolver.js` — revalidate/retry

`resolveTrack`'s per-provider loop changes from a synchronous `canResolve` check to:

```js
if (!(await provider.canResolve(ref))) continue;
try {
  return await provider.resolve(ref);
} catch (originalErr) {
  const originalReason = originalErr instanceof Error ? originalErr.message : String(originalErr);
  if (provider.capabilities?.requiresRevalidation) {
    const revalidation = await provider.revalidate(ref).catch(() => ({ valid: false }));
    if (revalidation.valid && revalidation.ref) {
      try {
        return await provider.resolve(revalidation.ref);
      } catch (retryErr) {
        failedSources.push({
          ref,
          reason: retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
        continue;
      }
    }
    failedSources.push({ ref, reason: originalReason || revalidation.reason || 'resolution failed' });
    continue;
  }
  failedSources.push({ ref, reason: originalReason });
  continue;
}
```

The retry is gated strictly behind `provider.capabilities?.requiresRevalidation` — a provider that doesn't declare this capability gets the old behavior (one `resolve()` attempt, straight to `failedSources` on failure), so this is additive, not a behavior change for `source-local-fs` or any future provider that doesn't need it.

### `packages/core/src/PluginRegistry.js`

`getPlaybackEngineFor(resolved)` changes from a synchronous `.find()` to an async `for...of` loop that `await`s each engine's `canPlay(resolved)` in registration order, returning the first that resolves `true`. A new `getPlaybackEngines()` method returns a copy of every registered engine, in registration order — needed by `CorePlayer.initializePlugins()`/`dispose()` to iterate every engine without reaching into the registry's private state.

### `packages/core/src/CorePlayer.js` — lifecycle and lookahead-plan

**Lifecycle.** A new `#initialized` private field, `PluginsNotInitializedError` (exported alongside `CorePlayer`), `initializePlugins(hostContext)` calling `initialize(hostContext)` on every registered source provider, playback engine, metadata provider, and playlist provider, and `dispose()` doing the same for `dispose()`. `play()` throws `PluginsNotInitializedError` synchronously (before entering the `#enqueue` operation chain) if `initializePlugins()` hasn't been called yet.

**Lookahead-plan for `queueAuthority: 'engine'`.** `#loadAndPlayCurrent()` branches:

```js
if (engine.capabilities?.queueAuthority === 'engine' && engine.setPlaybackPlan) {
  const plan = await this.#resolveLookaheadPlan(queueItem, resolved);
  await engine.setPlaybackPlan(plan);
} else {
  await engine.load(resolved);
  await engine.play();
}
```

`#resolveLookaheadPlan(startItem, startResolved)` builds a `PlaybackPlanEntry[]` of the current item plus up to `DEFAULT_LOOKAHEAD_WINDOW` (3) subsequent items, resolving each via `Resolver` and silently dropping any item that fails to resolve (an engine-owned plan should not abort playback of the current track because track #3 ahead can't be resolved — it just plays fewer tracks ahead than the window allows). `#refreshLookaheadPlan()` re-runs the same resolution and re-pushes the plan whenever the queue changes (add/remove/reorder) while an engine-owned engine is active, via the constructor's existing `queue.on('changed', ...)` handler, extended with an `else if (loadedId)` branch.

Engine-owned engines report intra-plan track advancement via a `'trackChanged'` event (payload: the `queueItemId` the engine has moved to) instead of `'ended'`. `#bindEngine` attaches a `'trackChanged'` listener for engine-owned engines and an `'ended'` listener for core-owned ones — never both. `#reconcileEngineOwnedTrackChange(queueItemId)` moves `CorePlayer`'s own queue cursor (`queue.setCurrentIndex`) to match, so `getState().currentQueueItem` stays correct even though `CorePlayer` didn't initiate the transition.

**Known limitation, documented in code comments in `#resolveLookaheadPlan`:** the lookahead window is built by walking `queue.getItems()` in linear order. It does not go through `QueueManager`'s shuffle-order history, because `QueueManager` doesn't currently expose a non-mutating "peek the next N items in playback order" method — only "what's the current item" and "advance to the next item" (which is stateful). For a shuffled queue, this means the lookahead plan handed to an engine-owned engine can include tracks that aren't actually next in shuffle order. This is scoped out of v0.2.0 deliberately (see Out of Scope) rather than adding a peek method to `QueueManager` under this same change.

All existing volume, shuffle, repeat, `#enqueue` concurrency-guard, and async `restoreState` logic (delivered in the 2026-08-15 and 2026-08-16 work) is unchanged.

### `packages/core/src/index.js`

Adds `PluginsNotInitializedError` to the existing `CorePlayer` export; re-exports `TrackResolutionError` from `Resolver.js` (previously internal-only, needed now that `Resolver`'s error shape is part of the contract a host might want to catch specifically).

### `packages/source-local-fs`

`capabilities: { offline: true, requiresRevalidation: false }` — a local file's path either exists or doesn't; there's nothing to revalidate. `initialize`/`dispose` are no-ops (no connection, no resources). `canResolve` becomes `async`, wrapping the existing synchronous check. The existing directory-vs-file rejection (`if (!stats.isFile()) throw new Error('Not a regular file: ...')`) is preserved verbatim — this package's actual resolution behavior does not change, only its contract shape.

### `packages/engine-web-audio`

`capabilities: { gapless: false, backgroundPlayback: false, queueAuthority: 'core' }` — this engine has no native queue and is always core-driven. `initialize` is a no-op. `dispose()` closes the underlying `AudioContext` (`if (audioContext.state !== 'closed') await audioContext.close();` — guarded, since closing an already-closed context throws in some browsers). `canPlay` becomes async. Since this engine is core-owned, it will never itself emit `'trackChanged'`, but `on()`'s type signature is widened to accept it anyway (as a documented no-op) so a host wiring up an engine-agnostic event bridge doesn't need to type-check `queueAuthority` before subscribing. The existing `gainNode`-based volume chain (`sourceNode → gainNode → destination`, `setVolume`/`getVolume` via `gainNode.gain.value`) is untouched.

### `packages/source-subsonic`

This is the package the revalidate/retry path exists for. `capabilities: { offline: false, requiresRevalidation: true }`. `initialize`/`dispose` no-ops (this package doesn't hold a persistent connection — each resolve is a fresh signed-URL request). `canResolve` becomes async. `revalidate(ref)` re-signs a fresh URL by re-running the same resolution logic used by `resolve()`, returning `{ valid: true, ref }` on success or `{ valid: false, reason }` on failure. Note the shape is deliberately just `{ valid, ref }`, not `{ valid, ref, resolved }` — `RevalidationResult` only declares `valid`/`ref`/`reason`, and `Resolver` re-runs `provider.resolve(revalidation.ref)` itself rather than trusting a pre-resolved payload from `revalidate()`, so there's no reason for the extra field (an earlier draft of this implementation included it and it failed `tsc --checkJs`'s excess-property check on object literals).

### `packages/metadata-local-fs`, `packages/playlist-local-fs`

Both gain `initialize`/`dispose` no-ops only — neither has a `capabilities` field, since capability negotiation in this contract is specifically about resolution/playback fallibility, which these two categories don't participate in.

### `apps/electron-demo`

`main.js`: `metadataProvider` isn't registered with `CorePlayer`'s plugin registry (it's called directly via the `fetch-metadata` IPC handler), so it can't go through `CorePlayer.initializePlugins()`. Its `initialize()` is called once, directly, right after construction, at startup.

`preload.mjs`: the `DOMContentLoaded` handler becomes `async`; after registering `source-local-fs` and `engine-web-audio` and before setting up the playlist provider, it calls `await core.initializePlugins({ log: ..., config: {}, host: { platform: 'electron', version: process.versions.electron } })`. A `beforeunload` listener calls `core.dispose().catch(...)` near the end of the handler.

## Implementation Decisions (need your sign-off)

1. **`dispose()` is required on every plugin category, not optional.** Most existing plugins have nothing to dispose (no-op), which is some ceremony for little benefit today. Alternative: make `dispose` optional and let `CorePlayer.dispose()` skip plugins that don't define it. Recommend: keep it required. A plugin that opens a real resource (a connection, an `AudioContext`, a native player handle) and forgets to implement `dispose` because it was optional is a much worse failure mode (silent resource leak) than every plugin author writing one extra `async dispose() {}` line.

2. **The revalidate/retry loop only retries once.** If the revalidated `ref` also fails to resolve, `Resolver` gives up on that provider and moves to `failedSources` — it does not revalidate again. Alternative: loop revalidate→resolve until some max-attempts count. Recommend: single retry. A provider whose freshly-revalidated URL immediately fails again is very likely broken in a way retrying won't fix (auth misconfiguration, server down), and an unbounded or counted retry loop adds real complexity (backoff, cancellation) for a case that isn't the one motivating this feature (an expired-but-otherwise-working signed URL).

3. **Lookahead-plan window is a fixed constant (`DEFAULT_LOOKAHEAD_WINDOW = 3`), not configurable per-engine or via `capabilities`.** Alternative: let `PlaybackEngineCapabilities` declare a preferred window size. Recommend: fixed constant for v0.2.0, revisit if/when a second `queueAuthority: 'engine'` implementation actually needs a different number — there's no real engine-owned implementation yet (only the lookahead-plan *plumbing* is landing in this release) to validate what the right per-engine knob would even look like.

4. **The lookahead plan walks `queue.getItems()` in linear order, not shuffle order** (see Solution, "Known limitation"). Alternative: block this feature on adding a non-mutating peek method to `QueueManager` first. Recommend: land the plumbing now with the limitation documented in code, and treat the `QueueManager` peek method as its own follow-up — see Out of Scope. The motivating case (WKWebView JS suspension) applies equally to shuffled and unshuffled queues, so shipping the core mechanism now is more valuable than blocking it on a `QueueManager` API addition that's a separate concern.

5. **`canResolve`/`canPlay` becoming async is a breaking signature change for every existing plugin**, not an additive/optional one. Alternative: support both sync and async return values (`boolean | Promise<boolean>`) for backward compatibility. Recommend: hard breaking change, consistent with this being a `0.x` → `0.x` semver-minor-as-breaking release (per the project's stated pre-1.0 versioning policy) and with every in-repo plugin being updated in the same change. A dual sync/async signature is exactly the kind of ambiguity that made the original synchronous-only contract insufficient in the first place.

## Testing Decisions

1. `packages/core/test/PluginRegistry.test.js`: `getPlaybackEngineFor` tests converted to `async`/`await`; new test asserting `getPlaybackEngines()` returns every registered engine in registration order.
2. `packages/core/test/CorePlayer.test.js`: every existing test that calls `play()` now calls `await core.initializePlugins({})` first (mechanical, applies to all pre-existing tests); new tests: `play()` throws `PluginsNotInitializedError` before `initializePlugins()`; `initializePlugins()` calls `initialize()` on every registered plugin with `ctx.host`/`ctx.config`/`ctx.log` present; `dispose()` calls `dispose()` on every plugin, and a subsequent `play()` requires re-initialization; an engine-owned (`queueAuthority: 'engine'`) mock engine receives a `setPlaybackPlan` call instead of `load`/`play`; an engine-owned engine's `'ended'` event (if it emitted one, which it shouldn't) is ignored; an engine-owned engine's `'trackChanged'` event reconciles `CorePlayer`'s queue cursor; a queue mutation while an engine-owned engine is active triggers a lookahead-plan refresh.
3. `packages/core/test/index.test.js`: new test asserting the public entry point exports `PluginsNotInitializedError`.
4. `packages/core/test/helpers/mockPlugins.js`: `createMockSourceProvider`/`createMockPlaybackEngine` updated to produce contract-v0.2.0-shaped mocks by default (capabilities, `initialize`/`dispose`, async `canResolve`/`canPlay`, `revalidate`), while preserving every existing test's ability to configure sync-style behavior via `canResolveImpl`/`canPlayImpl` config properties, so this file's changes don't ripple into rewriting every existing test's mock setup.
5. `packages/source-local-fs/test/index.test.js`: async `canResolve` tests; new `capabilities`/`initialize`+`dispose`/`revalidate` tests (revalidate isn't meaningfully exercised beyond existing, since `requiresRevalidation: false`, but the method's shape is asserted).
6. `packages/engine-web-audio/test/index.test.js`: async `canPlay` tests; new `capabilities`/`initialize`/`dispose` tests, including `dispose()` being a no-op when the `AudioContext` is already closed (`domStubs.js`'s fake `AudioContext` gained an `async close()` that sets `state = 'closed'`, to make this assertable).
7. `packages/source-subsonic/test/index.test.js`: async `canResolve` tests; new `capabilities`/`initialize`+`dispose` tests; new `revalidate()` success and failure tests.
8. `packages/metadata-local-fs/test/index.test.js`, `packages/playlist-local-fs/test/index.test.js`: one new test each, `'initialize and dispose resolve without throwing'`.
9. Final counts: 201/201 tests passing across the workspace (122 `@unitrack/core`, 28 `engine-web-audio`, 12 `metadata-local-fs`, 13 `playlist-local-fs`, 10 `source-local-fs`, 11 `source-subsonic`, 5 `util-fs`), `tsc --checkJs` clean across all 8 workspace packages.

## Out of Scope

- **A non-mutating "peek next N items" method on `QueueManager`.** The lookahead-plan feature needs this to be shuffle-aware, but adding it is a `QueueManager`-focused change with its own design questions (does it account for `repeatMode`? does peeking past the end of a non-repeating queue return fewer than N items or wrap?) that shouldn't be decided as a side effect of this contract change.
- **An actual `queueAuthority: 'engine'` playback engine implementation** (e.g. an `AVQueuePlayer`-backed engine for iOS/Electron background playback). This release ships the `CorePlayer`-side plumbing (`setPlaybackPlan`, `'trackChanged'` handling, lookahead-plan resolution/refresh) so such an engine has something to be built against, but no such engine exists in this repo yet.
- **Bumping `@unitrack/util-fs`.** It has no plugin-category contract (it's a pure filesystem-title-formatting utility, `titleFromFilename`) and is untouched by any part of this change, so it stays at `0.1.0`.
- **Multi-attempt/backoff revalidation.** See Implementation Decision 2 — a single revalidate-and-retry is what ships; anything more is future work if a real provider turns out to need it.
- **A `capabilities`-based UI affordance** (e.g. showing an "offline available" badge from `SourceProviderCapabilities.offline`). `capabilities` exists in this release purely for `CorePlayer`/`Resolver`'s own internal decision-making; no host application code in this repo reads `capabilities` for display purposes yet.
