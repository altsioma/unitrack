# Core Player — Design Spec

Date: 2026-08-13

## Purpose

A headless Core Player written in plain JavaScript (JS + JSDoc types, checked
via `tsc --checkJs`, no build/compile step): a UI-, backend-, and
platform-independent music player core. It manages the music domain model,
queue, playback, and resolution of logical tracks into physical sources. It
supports arbitrary sources and playback engines via plugins, lets a single
logical track/album combine streaming and local versions, picks the best
source per a configurable policy, and is extensible later via plugins
(metadata/playlist providers today; EQ, audio processing, visualizers as
future plugin categories).

**Primary target environment:** cross-platform from day one — an
Electron/Tauri desktop app is the first host, but the core itself must not
assume a specific runtime.

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                   Core Player                     │
│  (public API: play/pause/next/seek/getState)      │
├─────────────────────────────────────────────────┤
│  Queue Manager   │  Resolver   │  Playback Orch.  │
├─────────────────────────────────────────────────┤
│              Plugin Registry                       │
├──────────┬──────────┬───────────┬─────────────────┤
│  Source  │ Playback │ Metadata  │  Playlist        │
│ Provider │  Engine  │ Provider  │  Provider        │
│ (plugin) │ (plugin) │ (plugin)  │  (plugin)        │
└──────────┴──────────┴───────────┴─────────────────┘
```

Core is an orchestrator with no knowledge of concrete sources or playback
mechanisms — only of plugin contracts and the domain model below.

## Domain Model

- **`LogicalTrack`** — the canonical track: `id`, `metadata`
  (artist/album/title/duration/...), `sources: SourceRef[]`. Carries no
  playback information, only "what this track is."
- **`SourceRef`** — a reference to one concrete version:
  `{ pluginId, sourceId, kind }` (`kind`: `'local' | 'streaming' |
  'self-hosted' | ...`), plus arbitrary quality metadata defined by the
  Source Provider itself.
- **`ResolvedSource`** — returned by `SourceProvider.resolve(sourceRef)`: a
  concrete playable handle (URL, file handle, stream) plus actual parameters
  (format, bitrate).
- **`QueueItem`** — wraps a `LogicalTrack` in the queue, giving it a
  queue-scoped id distinct from the track id (the same track can appear in
  the queue more than once).

### Track identity — no automatic matching

The core does **not** attempt to automatically determine that a local FLAC
and a Spotify track are "the same" logical track. A `LogicalTrack` with
multiple `sources[]` is only created when:

1. the user explicitly links versions together, or
2. a Metadata/Playlist Provider already returns a ready-made `sources[]`
   array.

Core stores and uses this structure; it does not perform matching. Automatic
fuzzy/MusicBrainz-style identity matching is explicitly out of scope (see
Non-goals) and would be a future Identity Provider plugin category.

## Plugin Execution Model

Plugins run **in-process, as trusted code** — ordinary JS modules/objects
registered directly against Core's internal API. No sandboxing on this pass.

## Plugin Interfaces

### Source Provider

Turns a `SourceRef` into a playable `ResolvedSource`.

```js
/**
 * @typedef {Object} SourceProvider
 * @property {string} id                 - unique plugin id, e.g. 'local-fs', 'spotify'
 * @property {string} kind               - 'local' | 'streaming' | 'self-hosted' | ...
 * @property {(ref: SourceRef) => boolean} canResolve
 * @property {(ref: SourceRef) => Promise<ResolvedSource>} resolve
 * @property {() => Promise<void>} [dispose]
 */
```

Registered via `core.registerSourceProvider(plugin)`. Multiple Source
Providers can be registered simultaneously (e.g. local-fs + spotify +
subsonic). Core picks the right one by `pluginId` on the `SourceRef`;
`canResolve` is a defensive check.

### Playback Engine

Plays a `ResolvedSource`.

```js
/**
 * @typedef {Object} PlaybackEngine
 * @property {string} id
 * @property {(resolved: ResolvedSource) => boolean} canPlay
 * @property {(resolved: ResolvedSource) => Promise<void>} load
 * @property {() => Promise<void>} play
 * @property {() => Promise<void>} pause
 * @property {() => Promise<void>} stop
 * @property {(seconds: number) => Promise<void>} seek
 * @property {() => EngineState} getState   - position, duration, buffering
 * @property {(event: 'ended'|'error'|'progress', handler: Function) => void} on
 * @property {() => AudioNode | undefined} [getAudioGraphAnchor]  - extension point for EQ/DSP plugins
 */
```

Registered via `core.registerPlaybackEngine(plugin)`. MVP assumes a single
active engine (Web Audio API — works across browser, Electron, and most
Tauri webviews without needing a native backend), but the interface already
carries `canPlay()` so multiple engines can be registered and selected by
`ResolvedSource` in the future without breaking the contract.

#### Audio processing chain (EQ/DSP)

No universal engine-agnostic audio graph API is introduced yet. Instead:

- The single MVP playback engine exposes a minimal extension point,
  `getAudioGraphAnchor()`, returning a Web Audio node that EQ/DSP plugins can
  connect to.
- A full engine-agnostic audio graph abstraction is deferred until a second,
  genuinely different engine (e.g. a native backend for bit-perfect/exclusive
  output) exists — the abstraction should be designed from two real
  implementations, not speculatively.

### Metadata Provider

Enriches/searches metadata (cover art, tags, search by title).

```js
/**
 * @typedef {Object} MetadataProvider
 * @property {string} id
 * @property {(query: MetadataQuery) => Promise<TrackMetadata[]>} search
 * @property {(ref: SourceRef) => Promise<TrackMetadata>} [fetchForSource]
 */
```

### Playlist Provider

Returns a ready-made ordered list of `LogicalTrack`s, each with `sources[]`
already populated (per the no-auto-matching decision above — populating
`sources[]` is the provider's or the user's responsibility, not Core's).

```js
/**
 * @typedef {Object} PlaylistProvider
 * @property {string} id
 * @property {(playlistRef: PlaylistRef) => Promise<LogicalTrack[]>} fetchPlaylist
 * @property {() => Promise<PlaylistSummary[]>} [listPlaylists]
 */
```

## Resolution & Source Selection Policy

The policy is an ordered list of rules (ordered fallback):

```js
/** @typedef {{ kind?: string, pluginId?: string }} SourcePolicyRule */
// policy: SourcePolicyRule[]
```

Example:

```js
const policy = [
  { kind: 'local' },
  { kind: 'self-hosted' },
  { kind: 'streaming', pluginId: 'spotify' },
];
```

Resolution algorithm for a given `LogicalTrack`:

1. Iterate `policy` in order.
2. For each rule, find all `track.sources[]` entries matching its `kind`
   and/or `pluginId`.
3. For each matching source, in the order it appears in `track.sources`,
   call the matching `SourceProvider.resolve()`.
4. The first successful `resolve()` wins; stop.
5. If no rule/source produces a result, resolution fails entirely (see Error
   Handling).

## Queue

Minimal linear queue for the MVP — no shuffle, repeat, or gapless playback.

```js
queue.add(track | track[])        // append LogicalTrack(s)
queue.remove(queueItemId)
queue.reorder(queueItemId, newIndex)
queue.clear()
queue.getItems()                  // QueueItem[]
```

## Public API

```js
core.registerSourceProvider(plugin)
core.registerPlaybackEngine(plugin)
core.registerMetadataProvider(plugin)
core.registerPlaylistProvider(plugin)

core.setPolicy(policyRules)

core.play()
core.pause()
core.stop()
core.next()
core.prev()
core.seek(seconds)

core.getState()              // snapshot: status, currentQueueItem, position, duration, queue, policy
core.restoreState(snapshot)  // host restores queue/position after restart

core.on(event, handler)
core.off(event, handler)
```

### State & events model

Core exposes state via an `EventEmitter` + `getState()` snapshot, not a
reactive store. This keeps Core UI-framework-agnostic — it doesn't impose a
reactivity paradigm (signals/observables); UI adapters for React/Vue/etc. can
be built on top later.

Events: `stateChanged`, `trackChanged`, `positionChanged` (throttled, not
per-frame), `queueChanged`, `error`.

### Persistence

Core does **not** persist its own state between app launches. It only lives
in memory for the duration of a session. The host application is responsible
for saving/restoring state via `getState()` / `restoreState()`:

```js
const snapshot = core.getState();
localStorage.setItem('queue', JSON.stringify(snapshot));

// on startup:
core.restoreState(JSON.parse(saved));
```

### Error handling

If resolution fails entirely for a track (step 5 above), or a
`PlaybackEngine` emits an `error` during playback, Core:

1. Sets `status` to `'error'`.
2. Emits `error` with `{ queueItemId, trackId, reason, failedSources }`.
3. **Stops** — it does not automatically advance to the next queue item. The
   host decides whether to call `next()`, retry `play()`, surface a message
   to the user, etc. Auto-skip is host-side behavior built trivially on top
   of the `error` event, not built into Core.

## Non-goals (explicitly out of scope for this spec)

- Automatic track identity matching (fuzzy/MusicBrainz-style) — `sources[]`
  is always populated explicitly.
- Shuffle, repeat, gapless playback.
- EQ/DSP, visualizer, and Identity Provider plugins — only noted as future
  plugin categories, no interfaces defined here.
- Core-owned persistence.
- Plugin sandboxing/isolation — plugins are in-process, trusted code.
- Auto-skip on playback error — host-side behavior.
- A universal engine-agnostic audio graph API — deferred until a second
  playback engine exists.

## Testing Strategy

Plugin interfaces are simple and easy to mock. Test the Resolver, Queue, and
error/state transitions against in-memory `SourceProvider`/`PlaybackEngine`
implementations, without real audio or network I/O. JSDoc types are checked
via `tsc --checkJs` in CI/pre-commit, separately from runtime tests.

## Packaging

A single npm package (e.g. `@unitrack/core`) exporting the `CorePlayer`
class and the JSDoc type contracts for plugins. Concrete plugins (local-fs
provider, specific streaming integrations) are separate work, out of scope
for this spec.
