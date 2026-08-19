# Playback Coordination, Secure Delivery, and Contract v0.4 — Design Spec

Date: 2026-08-19

## Purpose

Advance UnitTrack's plugin contract from v0.3.0 to v0.4.0 while preserving a
single source of truth for playback policy. This pass resolves four connected
problems:

1. `queueAuthority: 'engine'` lets both `CorePlayer` and a playback engine
   partially own progression through the queue. The engine's pre-buffered
   lookahead and Core's queue pointer can disagree after a mutation or late
   event.
2. `ResolvedSource` can express URL headers, but the web engines currently
   assign `audio.src` directly and therefore cannot send them.
3. A `SourceToken` is provider-owned in concept, but its relation to a
   `SourceRef` is not validated and raw tokens can leak through diagnostics.
   `checkSourceAvailability()` also means only "a provider is registered".
4. Generated declarations are not exposed through package metadata, and the
   registry does not reject every malformed plugin shape at registration.

The result is a Core-owned canonical queue, a revisioned lookahead protocol
for engines that can optimise transitions, an internal web media-delivery
module, explicit availability results, and a contract consumable by JavaScript
and TypeScript plugin authors.

## Settled decisions

- This is one umbrella design with independently deliverable workstreams.
- It is an intentional breaking **plugin contract v0.4.0** change. Package
  versions remain independent; only changed packages receive SemVer bumps.
- Electron and web are equal first targets. Mobile shapes the contract but has
  no adapter in this pass.
- `CorePlayer` owns the canonical queue and its policy. Engines may optimise
  a supplied plan, but never own or mutate that queue.
- Direct mutable access to `core.queue` is removed from the public interface.
- A `SourceToken` is provider-owned, not necessarily secret: a local provider
  may use a path as its token. Tokens and delivery headers are still sensitive
  operational data and are excluded from normal logs, UI events, and errors.
- Web delivery is an internal shared module, not a public plugin category.

## Scope

### In scope

- Replace `queueAuthority` with a lookahead capability and a revisioned
  playback-plan protocol.
- Make Core's queue mutation commands the only public way to change its
  canonical queue.
- Add header-aware URL delivery to both current web engines.
- Specify token consistency, privacy, and an async source-availability result.
- Strengthen registration-time plugin validation.
- Publish generated `.d.ts` declarations through package `exports`.
- Migrate every first-party plugin, host, conformance test, and fixture.

### Out of scope

- A mobile engine, File System Access source, or a producer of
  `ResolvedSource.kind: 'stream' | 'buffer'`.
- A public media-delivery plugin category or universal streaming abstraction.
- Third-party plugin loading, sandboxing, a marketplace, or storage policy.
- Fully native background/gapless playback beyond browser/WebView limits.

## Domain model and invariants

The canonical language is captured in [`CONTEXT.md`](../../../CONTEXT.md).

`SourceRef.pluginId` and `SourceRef.token.pluginId` must be identical. A
mismatch is invalid input and is rejected before resolving, revalidating, or
persisting the ref. The duplicated ID is useful when only a token survives,
but contradictory routing information is never reconciled heuristically.

Only the provider that minted `token.token` may interpret it. Other modules
may persist and pass it through but must not parse it. A local filesystem
provider may still use a path as its token; opacity is not secrecy.

`token.token` and `ResolvedSource.headers` are excluded from standard error
payloads, user-facing events, and default logging. Diagnostics may contain
`pluginId`, `kind`, `displayPath`, a redacted URL origin, and a reason code.

The existing `ResolvedSource` delivery variants stay unchanged. v0.4
implements only `kind: 'url'` in the two web engines. An engine that cannot
consume `stream` or `buffer` returns `false` from `canPlay()`.

## Core-owned queue

`QueueManager` becomes private to `CorePlayer`. `getState().queue` remains a
snapshot, never a mutable handle. The following commands replace
`core.queue.*` access:

```js
core.enqueue(track | track[])              // QueueItem[]
core.removeFromQueue(queueItemId)          // boolean
core.reorderQueueItem(queueItemId, index)  // boolean
core.clearQueue()                          // void
core.selectQueueItem(queueItemId)          // boolean
core.setShuffle(enabled)                   // void
core.setRepeatMode(mode)                   // void
```

`selectQueueItem()` changes selection only. `play()` loads that selection;
`next()` and `prev()` remain immediate playback commands. All commands are
serialized on Core's operation chain. Queue mutations never interrupt the
currently sounding item; they replace only not-yet-started plan entries. An
explicit `next`, `prev`, `stop`, or `play` of another selection may replace
the current engine session.

## Revisioned playback-plan protocol

### Capability and interface

`PlaybackEngineCapabilities.queueAuthority` is removed. It is replaced by the
required boolean `lookaheadPlayback`:

```js
/**
 * @typedef {Object} PlaybackEngineCapabilities
 * @property {boolean} gapless
 * @property {boolean} backgroundPlayback
 * @property {boolean} lookaheadPlayback
 * @property {boolean} [nowPlaying]
 */

/**
 * @typedef {Object} PlaybackPlan
 * @property {number} revision
 * @property {PlaybackPlanEntry[]} entries
 */
```

When `lookaheadPlayback` is true, `setPlaybackPlan(plan)` is mandatory. Core
supplies a snapshot beginning with the selected item and up to its configured
lookahead window. The plan is disposable derived state, not a second queue.
Engines without lookahead keep the `load()` + `play()` path. `gapless`
describes transition quality; it is not ownership of the queue.

### Revisions and events

Core creates a strictly increasing revision whenever it installs, replaces, or
invalidates a plan. A lookahead engine treats a later revision as superseding
every earlier revision: it cancels outstanding preparation where possible,
releases resources for entries that never start, and never starts an
uncommitted entry from an older plan.

```js
engine.on('playbackStarted', ({ queueItemId, planRevision }) => {})
engine.on('playbackExhausted', ({ queueItemId, planRevision }) => {})
```

- `playbackStarted` fires for every actual start, including the initial play
  and a gapless hand-off. Core accepts it only for the current revision and an
  item in that plan; it then updates selection and emits Core's
  `trackChanged`.
- `playbackExhausted` fires after the last actually started entry in the
  accepted plan ends without a prepared successor. Core accepts only the
  current revision, applies repeat/shuffle/end-of-queue policy, and sends the
  next plan or becomes idle.
- Events for obsolete revisions are ignored, not treated as errors.

`trackChanged` is removed from the PlaybackEngine event contract. Core's own
public `trackChanged` event remains.

Failure to prepare a future entry is non-fatal: the current track continues,
then the engine emits `playbackExhausted` and Core performs normal resolution.
Failure of the active entry still follows the normal engine `error` path.

`engine-web-audio` declares `lookaheadPlayback: false`. `engine-audio-queue`
declares it true and implements revision semantics.

## Internal web media delivery

Create a shared internal module, tentatively `@unitrack/media-delivery-web`,
for both web engines. It has no plugin identity and is not public Core API.

```js
const lease = await acquireWebMediaUrl(resolved, { signal });
// Assign lease.url to HTMLMediaElement.src.
// lease.release() is idempotent.
```

- A URL without headers is direct: `lease.url === resolved.url`; release is a
  no-op.
- A URL with headers is fetched with those headers and an abort signal. A
  non-success status rejects with a sanitized delivery error. Its response is
  made into a Blob URL and release revokes it.
- The helper never logs raw headers or tokens and adds no credential mode
  beyond explicitly supplied headers.
- Both engines release a previous lease when replacing a source and every
  remaining lease on `stop()` and `dispose()`. Superseded plan work aborts and
  releases its lease.

The helper preserves the inexpensive native media path for ordinary URLs.
Fetch-to-Blob carries ordinary CORS and memory limits; true streaming and
native authenticated playback are deferred until real adapters need them.

## Source availability inspection

Replace `checkSourceAvailability(queueItemId): boolean` with:

```js
core.inspectSourceAvailability(queueItemId): Promise<{
  queueItemId: string,
  sources: Array<{
    pluginId: string,
    displayPath?: string,
    status: 'available' | 'providerMissing' | 'invalid' | 'unchecked',
    reason?: string,
  }>,
}>
```

The host calls it intentionally, for example after restoring a snapshot. Core
does not perform network or filesystem revalidation just because a queue was
restored. The method neither resolves nor plays media and never returns a raw
token.

- `providerMissing`: no registered provider matches the SourceRef.
- `available`: a provider requiring revalidation returned a valid token.
- `invalid`: that provider returned `valid: false`.
- `unchecked`: a registered provider does not require revalidation, or its
  revalidation could not complete. It does not prove playback will fail.

Core emits no overstated global `sourceUnavailable` event; hosts may render
availability from this structured result.

## Registration-time validation

`PluginRegistry.registerX()` validates before retaining a plugin:

- non-empty ID, exact `contractVersion === CONTRACT_VERSION`, and lifecycle
  methods `initialize` and `dispose`;
- every required capability key is present, known, and correctly typed;
- baseline category methods are functions;
- `lookaheadPlayback: true` requires `setPlaybackPlan`;
- `nowPlaying: true` requires `setNowPlaying`.

The registry is a fast structural guard. `@unitrack/conformance-kit` retains
behavioural validation in a plugin's real runtime; both share exported
contract-key lists and capability rules.

## Type declaration publishing

Every library continues to run source ESM JavaScript and generates declarations
to `dist/`. `package.json` exposes them through conditional exports:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./src/index.js"
    }
  }
}
```

Packages with a `./types` subpath expose matching type conditions. Published
artifacts include `dist/**/*.d.ts`; local `dist/` stays gitignored. Build
configuration must emit the exact files named by exports. No JS build step is
introduced.

## Migration and verification

1. Set `CONTRACT_VERSION` to `0.4.0` and introduce plan, queue-command,
   availability, redaction, and validation types.
2. Privatise `QueueManager`; migrate host and tests to Core commands.
3. Add plan revisions; migrate `engine-audio-queue`; remove `queueAuthority`
   and engine `trackChanged` paths.
4. Add the web delivery helper and integrate both engines.
5. Migrate providers, resolver errors, snapshots, conformance kit, and host
   diagnostics to token consistency and redaction rules.
6. Add availability inspection, strict registry checks, exports metadata, and
   a separate TypeScript consumer fixture.

Required tests cover stale events after a new revision, queue mutations during
pre-buffering, repeat/shuffle, non-fatal future-entry failure, header fetch
and Blob cleanup in both engines, token/headers redaction, every availability
status, registry rejection rules, and TypeScript imports through published
exports. The repository gates remain `npm test`, `npm run typecheck`, and
`npm run build:types`; the Electron demo additionally receives manual audible
verification.
