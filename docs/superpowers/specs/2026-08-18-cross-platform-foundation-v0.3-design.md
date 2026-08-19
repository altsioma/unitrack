# Cross-Platform Foundation — Contract v0.3.0 + Package Layout — Design Spec

Date: 2026-08-18

## Problem Statement

Desktop, web, and mobile are now equal targets, decided across a longer Q&A (Q1–Q10) that this document treats as settled, not open: no UI plugins; plugins are authored by the maintainer (with AI assistance) against specs, compile-time only, with the door left open for third-party JS plugins on web/desktop later; web is a full player with a reduced plugin set, not a demo; the base feature set is cross-platform, platform-specific behavior lives in plugins and is declared as capabilities; the codebase stays JS+JSDoc with generated `.d.ts`.

`@unitrack/core@0.2.0` (already merged to `master`) shipped part of what that Q&A called for: async `canResolve`/`canPlay`, plugin `initialize`/`dispose`, `PluginsNotInitializedError`, ad hoc `capabilities` fields per plugin category, and `queueAuthority: 'engine'` with a lookahead-plan mechanism (`setPlaybackPlan`/`'trackChanged'`) — the last of these matches the plan's "native engine gets a window of 3–5 upcoming sources" almost exactly, and a real implementation (`@unitrack/engine-audio-queue`) now exists against it.

What 0.2.0 did **not** ship, and what this document specs:

- `ResolvedSource` is still a bare `{ url, format?, bitrate? }` — no MIME, no headers, no non-URL delivery (a `blob:`/`content://`/`ph://`/in-memory buffer has nowhere to go), so every engine re-derives its own extension→MIME table and no source can express "this needs an `Authorization` header."
- `SourceRef.sourceId` is still an implicitly-a-path string. `source-local-fs` treats it as an absolute filesystem path today, and that same value is what ends up in a persisted `CoreState` snapshot — a value with no meaning on mobile (no such path after a reinstall) and no meaning on the web (no local filesystem at all).
- `capabilities` exist per-category as whatever ad hoc fields each `*Capabilities` typedef happens to declare, with no contract version, no closed enumerable list, and no runtime check that a registered plugin's declared capabilities actually match its shape — `types.js` ends in `export {}`, so every type only exists at `tsc --checkJs` time.
- All eight plugin packages are flat under `packages/*`, with no distinction between "works everywhere" (`engine-web-audio`, and — once its one Node dependency is replaced — `source-subsonic`) and "desktop-only because it touches `node:fs`" (`source-local-fs`, `metadata-local-fs`, `playlist-local-fs`, `util-fs`).
- There is no conformance-kit, so every plugin package hand-writes its own version of "does this satisfy the `SourceProvider` contract" instead of running a shared suite.
- There is no generated `.d.ts` — the only type-checking is internal (`tsc --checkJs --strict` inside each package), so a future TypeScript-authored host or third-party plugin has no `.d.ts` to consume.

## User Stories

1. As `source-subsonic`, I want to hand back a resolved source with the `Authorization`/session headers it needs, instead of embedding credentials in the URL query string as the only option.
2. As a future `web/source-file-system-access` plugin, I want to hand back an in-memory `ArrayBuffer` or a `blob:` URL instead of being forced to synthesize something that merely *looks* like a `file://`-style URL.
3. As `CorePlayer`, restoring a persisted queue on a fresh app launch, I want a source token that is self-describing enough (`{ pluginId, token, displayPath? }`) to show the user *something* meaningful for a track whose provider isn't registered yet or whose token no longer resolves, instead of either crashing or silently dropping the item.
4. As a host composing a plugin set for a specific target (Electron demo, a future web build, a future Android build), I want a single manifest module listing which plugins to import, and to see each one's declared capabilities before wiring it up — not to `import` a package and find out at runtime what it can and can't do.
5. As the author of a fifth plugin package, I want a conformance-kit I can run against my implementation, so "does this satisfy the `SourceProvider` contract" is a shared, maintained test suite instead of a hand-copied one.
6. As a TypeScript-authored consumer (a future host, or a third-party plugin author), I want real `.d.ts` files to import, not just the assurance that the JS was internally type-checked.

## Solution

### `ResolvedSource` becomes a delivery-variant descriptor

```js
/**
 * @typedef {Object} ResolvedSource
 * @property {'url' | 'stream' | 'buffer'} kind
 * @property {string} [url] - present when kind === 'url'; may be file://, blob://, content://, ph://, or a plain http(s) URL
 * @property {ReadableStream} [stream] - present when kind === 'stream'
 * @property {ArrayBuffer} [buffer] - present when kind === 'buffer'
 * @property {string} mime
 * @property {Record<string, string>} [headers] - request headers a consumer must send when fetching `url` (e.g. Authorization) — never embedded in the URL itself
 * @property {number} [bitrate]
 */
```

`format` (a bare extension string) is dropped in favor of `mime` — every current call site that branches on `format` (both engines' extension→MIME tables) collapses into reading `mime` directly off the resolved source instead of re-deriving it. Existing `kind: 'url'` producers (`source-local-fs`, `source-subsonic`) both keep working with a one-line wrapper (`{ kind: 'url', url, mime, headers }`); `stream`/`buffer` have no producer yet in this repo — they exist so a future `web/source-file-system-access` (File System Access API — no stable path, a live `File`/stream handle instead) and a future mobile photo/media-library source have somewhere to put a non-URL result without another breaking change.

### `sourceId` becomes an opaque, self-describing token

```js
/**
 * @typedef {Object} SourceToken
 * @property {string} pluginId - which provider minted this token; lets a token be interpreted without the enclosing SourceRef's context (e.g. during snapshot restoration before providers are registered)
 * @property {string} token - fully opaque outside the owning provider; never parsed, displayed, or persisted-as-a-path by anything else
 * @property {string} [displayPath] - human-readable, safe to show/persist/log even when the token itself no longer resolves; NOT used for resolution
 */
```

`SourceRef.sourceId: string` is replaced by `SourceRef.token: SourceToken`. `SourceRef.pluginId` (routing — "which registered provider handles this ref") stays; `SourceToken.pluginId` is a separate, deliberately redundant copy for when only the token itself survives (a persisted snapshot's queue item, read back before any provider has registered). `provider.revalidate` now takes a `SourceToken`, not a full `SourceRef` — matching "у источника появляется `revalidate(token)`" from the locked decisions.

`source-local-fs` moves from "the path is the `sourceId`" to `{ pluginId: 'local-fs', token: <opaque, provider-chosen>, displayPath: <the path> }` — the path becomes explicitly *display* metadata, not the resolution key, closing the gap where a persisted snapshot's `sourceId` was a raw filesystem path with no meaning on another platform.

A track whose token no longer resolves (revalidation fails, or the owning provider was never re-registered on this launch) now emits a `'sourceUnavailable'` event — `{ queueItemId, token }` — from `CorePlayer`, instead of the item simply failing to resolve and silently falling through to `failedSources` on the next `play()`. This is new, not a rename of the existing `'error'` event: `'error'` is playback failing *during* an attempt; `'sourceUnavailable'` is Core noticing, without attempting playback, that a queue item's token has no chance of resolving (used by a host to grey out or flag an item in a restored queue before the user even presses play).

### `capabilities` becomes a closed, versioned, validated descriptor

A `CONTRACT_VERSION` constant is added to `@unitrack/core/types` (starting at `'0.3.0'`, bumped alongside future breaking contract changes — not the same number as any individual package's `package.json` version, which can and will drift independently once packages are split across `packages/plugins/*`). Every plugin gains a required `contractVersion` field, checked at registration.

The four `*Capabilities` typedefs are consolidated into one closed union per plugin category (no open-ended `Record<string, boolean>` — every valid capability key is enumerated in `types.js`), and `PluginRegistry.registerX()` gains a runtime shape check: every declared capability key must be one this version of the contract knows about, and `contractVersion` must match `CONTRACT_VERSION` (or a range `CorePlayer` is willing to accept — see Implementation Decision 4). This stays informational, per the locked decision — `CorePlayer`/`Resolver` do not route by capability beyond what they already do (`requiresRevalidation`, `queueAuthority`); the host is still the one deciding policy. What changes is that a malformed or contract-mismatched plugin fails loudly at `registerX()` time instead of silently misbehaving the first time `CorePlayer` calls a method it assumed existed.

New capability, needed for system integration (Implementation Decision 3 covers scope): `PlaybackEngineCapabilities.nowPlaying: boolean`, paired with an optional `engine.setNowPlaying(info)` method. A lock-screen/CarPlay/Android-Auto button press arrives as a `PlaybackEngine` event (`'transportCommand'`, payload `{ command: 'play'|'pause'|'next'|'previous' }`); the *host* (not `CorePlayer`) is what translates that into a `CorePlayer.play()`/`pause()`/`next()`/`prev()` call — `CorePlayer` does not listen for `'transportCommand'` itself, matching the existing principle that the host owns policy and `CorePlayer` never reaches into a plugin unprompted.

### `PlaybackEngine.off()`

`#boundEngines` in `CorePlayer` has never been able to detach a listener — every engine that has ever been bound stays bound for the process's lifetime, which is invisible with one engine alive at a time but is a real leak once a host swaps engines (e.g. switching output devices, or a future `queueAuthority: 'engine'` engine that gets disposed and replaced). `PlaybackEngine.off(event, handler)` is added as a required, symmetric counterpart to `on()`; `CorePlayer.dispose()` now calls `off()` for every listener it attached in `#bindEngine`, in addition to the existing `plugin.dispose()` call.

### Package layout: three tiers

```
packages/core                              # @unitrack/core — unchanged location
packages/shared/<name>                     # portable logic with no plugin identity of its own
packages/plugins/any/<name>                # works on every platform unmodified
packages/plugins/desktop/<name>
packages/plugins/web/<name>
packages/plugins/android/<name>
packages/plugins/ios/<name>
```

Existing packages move as follows: `engine-web-audio` → `plugins/any/` (already portable — it's the browser Web Audio API, which Electron's renderer also has). `engine-audio-queue` → `plugins/any/` (same reasoning — plain `HTMLAudioElement`, no Node dependency). `source-subsonic` → `plugins/any/`, but only *after* its one Node dependency (`node:crypto`'s `createHash('md5')`, used for Subsonic's token-auth scheme) is replaced with a small dependency-free JS MD5 implementation — `WebCrypto` has no MD5, so this cannot simply switch to `crypto.subtle`. `source-local-fs`, `metadata-local-fs`, `playlist-local-fs`, `util-fs` → `plugins/desktop/` (all touch `node:fs`; `metadata-local-fs` additionally has the dynamic-`import()`-crashes-a-renderer issue documented in the electron-demo design spec, which is desktop/Electron-specific troubleshooting, not a portability question, but keeps it desktop-only for now regardless). `packages/shared/` starts empty — nothing in the current codebase needs factoring out into it yet; it exists so the *next* package that needs portable-but-not-a-plugin logic (e.g. a header-derivation helper shared between two HTTP-based source providers) has somewhere to go without inventing the tier under time pressure.

The npm workspaces glob (`root package.json`'s `"workspaces"`) changes from `["packages/*", "apps/*"]` to `["packages/*", "packages/plugins/*/*", "packages/shared/*", "apps/*"]` — npm workspaces globs are not recursive, so the plugin tier needs its own explicit two-level pattern.

### Host composition: a plain manifest module, no build flags

Each host gets a `<host>/plugins.js` (or equivalent) that just imports and registers the packages it wants:

```js
// apps/electron-demo/plugins.js
export { createLocalFileSourceProvider } from '@unitrack/source-local-fs';
export { createWebAudioPlaybackEngine } from '@unitrack/engine-web-audio';
export { createLocalFileMetadataProvider } from '@unitrack/metadata-local-fs';
export { createLocalFolderPlaylistProvider } from '@unitrack/playlist-local-fs';
```

No plugin-selection build step, no feature flags, no dynamic discovery — "dumb module, list of imports," exactly as decided. A future web host's manifest imports `engine-web-audio` and `source-subsonic` from `plugins/any/` and nothing from `plugins/desktop/`.

### `.d.ts` generation

Each package's `tsconfig.json` gains a sibling `tsconfig.build.json` (`emitDeclarationOnly: true`, extending the existing `checkJs`/`strict` config) and a `build:types` script running `tsc -p tsconfig.build.json`. Output lands in a gitignored `dist/` per package; nothing about the existing `main`/`exports` (pointing straight at `src/*.js`) changes — `.d.ts` output is an additional, opt-in artifact for a TS consumer, not a build step this repo's own JS packages depend on each other through.

### Conformance-kit

`packages/shared/conformance-kit` exports one plain, framework-agnostic function per plugin category — `assertSourceProviderConformance(provider, sampleRef)`, `assertPlaybackEngineConformance(engine, sampleResolvedSource)`, etc. — each a sequence of plain assertions (contract shape, `initialize`/`dispose` resolve, capability-declared behavior actually holds) with no dependency on `node:test` itself, so the *caller* decides how to run them: a `node --test` wrapper for `any`/`desktop`-tier packages (same as today), a headless-browser harness for `web`-tier packages, and — for `android`/`ios`, where there's no CI runner yet — an in-app developer self-check screen that calls the same functions and renders pass/fail, matching the locked decision that mobile's first testing story is manual-but-structured, not automated from day one.

## Implementation Decisions (need your sign-off)

1. **`ResolvedSource.kind` is a required, explicit discriminant (`'url' | 'stream' | 'buffer'`) rather than inferring the variant from which optional field is present.** Alternative: make `kind` optional and infer it. Recommend: required — an explicit discriminant is what makes `tsc`'s narrowing work cleanly on the union, and it documents intent even for a `'url'`-kind result (today's only real case) rather than leaving every future reader to wonder if `url` presence is really how they're supposed to detect the variant.

2. **`SourceToken.pluginId` duplicates `SourceRef.pluginId`.** Alternative: drop the duplicate and always require the enclosing `SourceRef` for routing. Recommend: keep the duplication — it's a few bytes, and it's exactly what makes a `'sourceUnavailable'` event or a persisted-then-restored queue item self-describing without needing the original `SourceRef` context to still exist.

3. **`nowPlaying`/`setNowPlaying`/`'transportCommand'` land now, as part of this same breaking pass, even though no engine implements them yet** (same situation `queueAuthority: 'engine'` was in when it shipped in 0.2.0, before `engine-audio-queue` existed). Alternative: defer until a real host needs it (e.g. the eventual Capacitor mobile shell). Recommend: land it now — it's a contract-shape addition, and bundling it into this pass avoids a third breaking contract version purely for system integration once mobile actually arrives. If this turns out over-scoped, cutting it before implementation is cheap; discovering it's needed *after* `packages/plugins/*` has already shipped as 0.3.0 is not.

4. **Contract version compatibility at registration is exact-match only (`contractVersion !== CONTRACT_VERSION` → throw), not a semver range.** Alternative: accept a compatible range (e.g. any `0.3.x`). Recommend: exact match for now — there is exactly one version of the contract in existence at the time this ships; a compatibility-range policy is a decision worth making when there are two versions to actually be compatible *between*, not speculatively now.

5. **Migration order for the package move itself:** `engine-web-audio` and `engine-audio-queue` (no Node dependency changes needed) move first, proving the workspace-glob and host-manifest mechanics work; `source-subsonic` moves once its MD5 dependency is replaced; the four `node:fs`-dependent packages move to `plugins/desktop/` last, as a single batch (they all move for the same reason and none blocks the others). Recommend confirming this order, since — per your own "дёшево" framing — the move itself is mechanical and this is really about sequencing which packages get to prove the mechanism holds up before the bulk of the packages ride on it.

## Testing Decisions

1. `packages/core/test/`: new tests for `ResolvedSource`'s `kind` discriminant round-tripping through `Resolver`/`CorePlayer` unchanged (both engines currently in this repo only ever produce/consume `kind: 'url'`, so existing behavior must not regress); `SourceToken`-shaped `sourceId` flowing through `resolveTrack`, `revalidate`, and a restored `CoreState` snapshot; `'sourceUnavailable'` firing for a token whose provider never registers; `PluginRegistry.registerX()` rejecting a plugin with an unknown capability key or a `contractVersion` mismatch; `CorePlayer.dispose()` calling `off()` for every listener `#bindEngine` attached (assertable via a mock engine's `_listenerCount(event)` dropping to zero).
2. `packages/shared/conformance-kit/test/`: the kit's own test suite runs itself against the existing mock plugins from `@unitrack/core/test/helpers/mockPlugins.js` (both a conformant and a deliberately-broken mock) to prove the assertion functions actually fail when they should, not just pass against well-behaved input.
3. Every migrated package (`source-local-fs`, `engine-web-audio`, `engine-audio-queue`, `source-subsonic`, `metadata-local-fs`, `playlist-local-fs`) gets its existing test file's `import`s updated for its new path and, additionally, a short `test/conformance.test.js` that just calls the relevant `assertXConformance()` function — replacing whatever hand-written "does this satisfy the contract" assertions already exist in each package's own suite with the shared kit, where they overlap.
4. `apps/electron-demo`: no automated test suite today (unchanged); manual verification that `plugins.js` composing the demo's plugin set still produces a working `electron .` run stays the one check for this host, same limitation flagged in `2026-08-18-core-contract-v0.2.md`.

## Out of Scope

- **Actually moving any files or rewriting any package.** This document specs the contract and layout; implementation is a separate plan, executed after sign-off, given its size (every one of the eight existing plugin packages changes location and/or contract shape, plus `CorePlayer`/`Resolver`/`PluginRegistry`/`types.js` all change again).
- **The web host, the mobile (Capacitor) shell, and the shared web UI.** This spec only lays the foundation (contract + layout + conformance-kit + `.d.ts`) those depend on; building them is explicitly the step *after* this one, per the locked-in order (web next, then Electron shrinks to a thin shell around the shared UI, then Capacitor).
- **Third-party plugin loading, sandboxing, and a plugin manifest/catalog.** Still "keep the door open, don't build the room" — plugins stay plain JS with no private host imports and a declared `contractVersion`, which is what keeps this option open; the loader/sandbox/catalog itself remains unbuilt until there is an actual third-party author.
- **The `QueueManager` shuffle-history / lookahead-plan interaction** (documented as a known limitation in `CorePlayer.js` since 0.2.0) and **`repeat: 'all'`'s wrap-around not being gapless for an engine-owned engine** (documented since `2026-08-18-engine-audio-queue-design.md`). Neither is touched by this pass.
- **`CoreState` persistence.** Confirmed as a host responsibility via a small storage adapter (a file under Electron's `userData`, `IndexedDB` on the web, `Preferences` under Capacitor) — not a new plugin category, and not something `@unitrack/core` itself gains an opinion about in this pass.
- **Replacing `source-subsonic`'s `node:crypto` MD5 usage.** Specced as a *precondition* for that package's move to `plugins/any/` (see Implementation Decision 5), but the actual MD5 implementation is small, self-contained follow-up work, not part of this design.
